//! Red-first contract tests for terminal maintenance failures.
//!
//! These tests deliberately exercise the public projection/read-model seam,
//! rather than a scheduler adapter.  A terminal contract failure must become
//! durable Finding history without creating Consumer Freshness, Edge, Domain,
//! or Attention state.

use grimodex_db::narrative_extraction::ensure_test_schema;
use grimodex_db::narrative_extraction::{
    build_maintenance_inbox, project_terminal_failure_for_run, resolve_terminal_failure_for_run,
    set_attention, AttentionDisposition, InboxEntryKind, SetAttentionRequest,
};
use grimodex_db::Database;
use rusqlite::params;

const PROJECT_ID: &str = "project-c2-5b-c";
const OTHER_PROJECT_ID: &str = "project-c2-5b-c-other";
const EPOCH_ID: &str = "epoch-c2-5b-c";
const SECOND_EPOCH_ID: &str = "epoch-c2-5b-c-second";
const OTHER_EPOCH_ID: &str = "epoch-c2-5b-c-other";
const WORK_KEY: &str = "legacy-dependency-backfill:v2";

fn fixture_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5B-C Project')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5B-C Other Project')",
            [OTHER_PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', '2026-08-22T00:00:00.000Z')",
            params![EPOCH_ID, PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', '2026-08-22T00:00:00.000Z')",
            params![OTHER_EPOCH_ID, OTHER_PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed fixture");
    db
}

#[allow(clippy::too_many_arguments)]
fn insert_run_for_context(
    db: &Database,
    run_id: &str,
    project_id: &str,
    semantic_epoch_id: Option<&str>,
    status: &str,
    run_kind: &str,
    work_key: Option<&str>,
    terminal_reason_code: Option<&str>,
) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, run_kind, semantic_epoch_id,
                 work_key, terminal_reason_code)
             VALUES (?1, ?2, 'maintenance', '{}', '{}', 'digest', ?3, '{}',
                     '2026-08-22T00:00:00.000Z', ?4, ?5, ?6, ?7)",
            params![
                run_id,
                project_id,
                status,
                run_kind,
                semantic_epoch_id,
                work_key,
                terminal_reason_code,
            ],
        )?;
        Ok(())
    })
    .expect("insert run");
}

fn insert_run(
    db: &Database,
    run_id: &str,
    status: &str,
    run_kind: &str,
    work_key: &str,
    terminal_reason_code: Option<&str>,
) {
    insert_run_for_context(
        db,
        run_id,
        PROJECT_ID,
        Some(EPOCH_ID),
        status,
        run_kind,
        Some(work_key),
        terminal_reason_code,
    );
}

fn observation_count(db: &Database) -> i64 {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_finding_observations",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
    })
    .expect("count observations")
}

fn lifecycle_state(db: &Database, finding_identity: &str) -> String {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT lifecycle_state
               FROM narrative_maintenance_finding_lifecycle
              WHERE project_id = ?1 AND finding_identity = ?2
              ORDER BY observed_at DESC, rowid DESC
              LIMIT 1",
            params![PROJECT_ID, finding_identity],
            |row| row.get(0),
        )
        .map_err(Into::into)
    })
    .expect("latest lifecycle state")
}

fn lifecycle_count(db: &Database, finding_identity: &str) -> i64 {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT COUNT(*)
               FROM narrative_maintenance_finding_lifecycle
              WHERE project_id = ?1 AND finding_identity = ?2",
            params![PROJECT_ID, finding_identity],
            |row| row.get(0),
        )
        .map_err(Into::into)
    })
    .expect("count lifecycle rows")
}

#[test]
fn transient_failure_is_not_projected_and_does_not_surface_in_inbox() {
    let db = fixture_db();
    insert_run(
        &db,
        "run-transient",
        "failed",
        "backfill",
        WORK_KEY,
        Some("NEX_MAINTENANCE_TRANSIENT"),
    );

    let outcome = project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-transient",
        "SQLITE_BUSY: database is locked",
    )
    .expect("classify transient failure");

    assert!(!outcome.projected);
    assert_eq!(observation_count(&db), 0);
    let entries = db
        .with_conn(|conn| build_maintenance_inbox(conn, PROJECT_ID, "2026-08-22T01:00:00.000Z"))
        .expect("build inbox");
    assert!(entries.is_empty());
}

#[test]
fn public_projection_requires_matching_durable_terminal_code_and_never_fills_it() {
    let db = fixture_db();
    insert_run(
        &db,
        "run-code-mismatch",
        "failed",
        "backfill",
        WORK_KEY,
        Some("NEX_VERIFY_NO_EPOCH"),
    );
    let mismatch = project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-code-mismatch",
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: caller lied",
    )
    .expect_err("a caller classification must not overwrite durable Run evidence");
    assert!(mismatch
        .to_string()
        .contains("NEX_FINDING_FAILURE_CODE_MISMATCH"));

    insert_run(
        &db,
        "run-code-missing",
        "failed",
        "backfill",
        "legacy-dependency-backfill:v3",
        None,
    );
    let missing = project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-code-missing",
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: terminal code absent",
    )
    .expect_err("public projection must not own terminalization");
    assert!(missing
        .to_string()
        .contains("NEX_FINDING_FAILURE_CODE_MISSING"));

    let (mismatch_code, missing_code, observations): (Option<String>, Option<String>, i64) = db
        .with_conn(|conn| {
            let mismatch_code = conn.query_row(
                "SELECT terminal_reason_code
                   FROM narrative_extraction_runs WHERE id = 'run-code-mismatch'",
                [],
                |row| row.get(0),
            )?;
            let missing_code = conn.query_row(
                "SELECT terminal_reason_code
                   FROM narrative_extraction_runs WHERE id = 'run-code-missing'",
                [],
                |row| row.get(0),
            )?;
            let observations = conn.query_row(
                "SELECT COUNT(*) FROM narrative_maintenance_finding_observations",
                [],
                |row| row.get(0),
            )?;
            Ok((mismatch_code, missing_code, observations))
        })
        .expect("read fail-closed projection state");
    assert_eq!(mismatch_code.as_deref(), Some("NEX_VERIFY_NO_EPOCH"));
    assert_eq!(missing_code, None);
    assert_eq!(observations, 0);
}

#[test]
fn projection_rejects_non_automatic_wrong_project_missing_work_and_missing_epoch() {
    let db = fixture_db();
    insert_run(
        &db,
        "run-non-automatic",
        "failed",
        "manual-rebuild",
        WORK_KEY,
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );
    insert_run_for_context(
        &db,
        "run-wrong-project",
        OTHER_PROJECT_ID,
        Some(OTHER_EPOCH_ID),
        "failed",
        "backfill",
        Some(WORK_KEY),
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );
    insert_run_for_context(
        &db,
        "run-missing-work",
        PROJECT_ID,
        Some(EPOCH_ID),
        "failed",
        "backfill",
        None,
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );
    insert_run_for_context(
        &db,
        "run-missing-epoch",
        PROJECT_ID,
        None,
        "failed",
        "backfill",
        Some("legacy-dependency-backfill:v3"),
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );
    insert_run(
        &db,
        "run-wrong-canonical-work",
        "failed",
        "backfill",
        "dependency-rebuild-derived",
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );

    for (run_id, expected_error) in [
        ("run-non-automatic", "NEX_FINDING_RUN_KIND_INVALID"),
        ("run-wrong-project", "NEX_FINDING_RUN_PROJECT_MISMATCH"),
        ("run-missing-work", "NEX_FINDING_WORK_KEY_MISSING"),
        ("run-missing-epoch", "NEX_FINDING_EPOCH_MISSING"),
        (
            "run-wrong-canonical-work",
            "NEX_FINDING_WORK_KEY_POLICY_MISMATCH",
        ),
    ] {
        let error = project_terminal_failure_for_run(
            &db,
            PROJECT_ID,
            run_id,
            "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: invalid context",
        )
        .expect_err("invalid maintenance context must fail closed");
        assert!(
            error.to_string().contains(expected_error),
            "{run_id} error should contain {expected_error}, got {error}"
        );
    }
    assert_eq!(observation_count(&db), 0);
}

#[test]
fn exact_failure_replay_after_resolution_is_a_noop_and_does_not_reopen_finding() {
    let db = fixture_db();
    insert_run(
        &db,
        "run-replay-failure",
        "failed",
        "backfill",
        WORK_KEY,
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );
    let first = project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-replay-failure",
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: replay",
    )
    .expect("project failure");

    insert_run(
        &db,
        "run-replay-success",
        "completed",
        "backfill",
        WORK_KEY,
        None,
    );
    assert!(
        resolve_terminal_failure_for_run(&db, PROJECT_ID, "run-replay-success")
            .expect("resolve failure")
            .resolved
    );
    assert_eq!(lifecycle_state(&db, &first.finding_identity), "resolved");
    let lifecycle_rows_before_replay = lifecycle_count(&db, &first.finding_identity);

    let replay = project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-replay-failure",
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: replay",
    )
    .expect("replay exact failure");
    assert!(!replay.projected);
    assert_eq!(lifecycle_count(&db, &first.finding_identity), lifecycle_rows_before_replay);
    assert_eq!(lifecycle_state(&db, &first.finding_identity), "resolved");
    assert!(db
        .with_conn(|conn| build_maintenance_inbox(conn, PROJECT_ID, "2026-08-22T05:00:00.000Z"))
        .expect("build inbox")
        .is_empty());
}

#[test]
fn terminal_failure_code_is_immutable_when_run_evidence_changes_or_run_is_deleted() {
    let db = fixture_db();
    insert_run(
        &db,
        "run-immutable-evidence",
        "failed",
        "backfill",
        WORK_KEY,
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );
    project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-immutable-evidence",
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: immutable",
    )
    .expect("project failure");

    let read_failure_code = |db: &Database| {
        db.with_conn(|conn| {
            let entries = build_maintenance_inbox(conn, PROJECT_ID, "2026-08-22T05:00:00.000Z")?;
            Ok(entries[0]
                .latest_observation
                .as_ref()
                .and_then(|observation| observation.failure_code.clone()))
        })
        .expect("read terminal failure code")
    };
    assert_eq!(
        read_failure_code(&db).as_deref(),
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION")
    );

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET terminal_reason_code = 'NEX_VERIFY_NO_EPOCH'
              WHERE id = 'run-immutable-evidence'",
            [],
        )?;
        Ok(())
    })
    .expect("mutate run terminal evidence");
    assert_eq!(
        read_failure_code(&db).as_deref(),
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION")
    );

    db.with_conn(|conn| {
        let deleted = conn.execute(
            "DELETE FROM narrative_extraction_runs WHERE id = 'run-immutable-evidence'",
            [],
        )?;
        assert_eq!(deleted, 1, "the observation must outlive its Run row");
        Ok(())
    })
    .expect("delete run ledger row");
    assert_eq!(
        read_failure_code(&db).as_deref(),
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION")
    );
}

#[test]
fn observation_and_lifecycle_projection_roll_back_as_one_transaction() {
    let db = fixture_db();
    insert_run(
        &db,
        "run-atomicity",
        "failed",
        "backfill",
        WORK_KEY,
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );
    db.with_conn(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER reject_terminal_lifecycle
               BEFORE INSERT ON narrative_maintenance_finding_lifecycle
               BEGIN
                 SELECT RAISE(ABORT, 'forced terminal lifecycle failure');
               END;",
        )?;
        Ok(())
    })
    .expect("install lifecycle failure trigger");

    let error = project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-atomicity",
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: lifecycle write fails",
    )
    .expect_err("lifecycle failure must abort the projection transaction");
    assert!(error
        .to_string()
        .contains("forced terminal lifecycle failure"));

    let (observations, lifecycles, terminal_code): (i64, i64, Option<String>) = db
        .with_conn(|conn| {
            let observations = conn.query_row(
                "SELECT COUNT(*) FROM narrative_maintenance_finding_observations",
                [],
                |row| row.get(0),
            )?;
            let lifecycles = conn.query_row(
                "SELECT COUNT(*) FROM narrative_maintenance_finding_lifecycle",
                [],
                |row| row.get(0),
            )?;
            let terminal_code = conn.query_row(
                "SELECT terminal_reason_code
                   FROM narrative_extraction_runs WHERE id = 'run-atomicity'",
                [],
                |row| row.get(0),
            )?;
            Ok((observations, lifecycles, terminal_code))
        })
        .expect("read atomic rollback state");
    assert_eq!(
        (observations, lifecycles, terminal_code),
        (
            0,
            0,
            Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION".to_string())
        )
    );
}

#[test]
fn terminal_failure_is_durable_idempotent_and_visible_without_freshness_or_attention() {
    let db = fixture_db();
    insert_run(
        &db,
        "run-terminal-1",
        "failed",
        "backfill",
        WORK_KEY,
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );

    let first = project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-terminal-1",
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: duplicate identity",
    )
    .expect("project terminal failure");
    assert!(first.projected);
    assert_eq!(observation_count(&db), 1);

    let replay = project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-terminal-1",
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: duplicate identity",
    )
    .expect("replay terminal failure");
    assert!(!replay.projected);
    assert_eq!(first.finding_identity, replay.finding_identity);
    assert_eq!(observation_count(&db), 1);

    let entries = db
        .with_conn(|conn| build_maintenance_inbox(conn, PROJECT_ID, "2026-08-22T01:00:00.000Z"))
        .expect("build inbox");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].entry_kind, InboxEntryKind::TerminalFailure);
    assert!(entries[0].evidence_freshness.is_none());
    assert!(entries[0].build_action.is_none());
    assert_eq!(
        entries[0]
            .latest_observation
            .as_ref()
            .expect("terminal observation")
            .rule_id,
        "narrative.maintenance-contract-failure"
    );

    let (freshness, edges, attention): (i64, i64, i64) = db
        .with_conn(|conn| {
            let freshness = conn.query_row(
                "SELECT COUNT(*) FROM narrative_consumer_freshness",
                [],
                |row| row.get(0),
            )?;
            let edges = conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edges",
                [],
                |row| row.get(0),
            )?;
            let attention = conn.query_row(
                "SELECT COUNT(*) FROM narrative_maintenance_attention",
                [],
                |row| row.get(0),
            )?;
            Ok((freshness, edges, attention))
        })
        .expect("read unrelated authorities");
    assert_eq!((freshness, edges, attention), (0, 0, 0));
}

#[test]
fn stable_identity_repeats_changed_basis_lapses_attention_and_resolves() {
    let db = fixture_db();
    insert_run(
        &db,
        "run-terminal-1",
        "failed",
        "backfill",
        WORK_KEY,
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );
    let first = project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-terminal-1",
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: duplicate identity",
    )
    .expect("project first failure");

    insert_run(
        &db,
        "run-terminal-2",
        "failed",
        "backfill",
        WORK_KEY,
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );
    let repeat = project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-terminal-2",
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: duplicate identity",
    )
    .expect("project repeated failure");
    assert_eq!(first.finding_identity, repeat.finding_identity);
    assert_eq!(observation_count(&db), 2);
    assert_eq!(lifecycle_state(&db, &first.finding_identity), "recurring");

    let attention_before = set_attention(
        &db,
        SetAttentionRequest {
            project_id: PROJECT_ID,
            finding_key: &first.finding_key,
            disposition: AttentionDisposition::Snoozed,
            material_basis_digest: &first.material_basis_digest,
            snoozed_until: Some("2999-01-01T00:00:00.000Z"),
            set_at: "2026-08-22T02:00:00.000Z",
            actor_id: "test",
            request_id: "request-terminal-attention",
            reason: Some("inspect later"),
            expected_version: 0,
        },
    )
    .expect("set test attention");
    assert_eq!(attention_before.version, 1);

    insert_run(
        &db,
        "run-terminal-3",
        "failed",
        "backfill",
        WORK_KEY,
        Some("NEX_VERIFY_NO_EPOCH"),
    );
    let changed = project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-terminal-3",
        "NEX_VERIFY_NO_EPOCH: no Semantic Epoch",
    )
    .expect("project changed failure");
    assert_eq!(first.finding_identity, changed.finding_identity);
    assert_ne!(first.material_basis_digest, changed.material_basis_digest);
    assert_eq!(observation_count(&db), 3);
    assert_eq!(lifecycle_state(&db, &first.finding_identity), "changed");

    let changed_entries = db
        .with_conn(|conn| build_maintenance_inbox(conn, PROJECT_ID, "2026-08-22T03:00:00.000Z"))
        .expect("build changed inbox");
    assert_eq!(changed_entries.len(), 1);
    assert_eq!(
        changed_entries[0]
            .attention
            .as_ref()
            .expect("attention remains durable")
            .material_basis_digest,
        first.material_basis_digest
    );
    assert!(!changed_entries[0].is_snoozed_and_active);

    insert_run(
        &db,
        "run-terminal-resolved",
        "completed",
        "backfill",
        WORK_KEY,
        None,
    );
    let resolved = resolve_terminal_failure_for_run(&db, PROJECT_ID, "run-terminal-resolved")
        .expect("resolve terminal failure");
    assert!(resolved.resolved);
    assert_eq!(resolved.finding_identity, first.finding_identity);

    let entries_after_resolution = db
        .with_conn(|conn| build_maintenance_inbox(conn, PROJECT_ID, "2026-08-22T04:00:00.000Z"))
        .expect("build resolved inbox");
    assert!(entries_after_resolution.is_empty());
    assert_eq!(lifecycle_state(&db, &first.finding_identity), "resolved");

    let attention_count: i64 = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_maintenance_attention",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
        .expect("count attention");
    assert_eq!(attention_count, 1);
}

#[test]
fn resolution_requires_a_newer_run_and_exact_work_kind_and_epoch() {
    let db = fixture_db();
    // Every fixture Run uses the same created_at value. The canonical
    // `(created_at, id)` order must still reject an older success.
    insert_run(
        &db,
        "run-success-old",
        "completed",
        "backfill",
        WORK_KEY,
        None,
    );
    insert_run(
        &db,
        "run-failure",
        "failed",
        "backfill",
        WORK_KEY,
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );
    project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-failure",
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: durable failure",
    )
    .expect("project failure");

    let old_resolution = resolve_terminal_failure_for_run(&db, PROJECT_ID, "run-success-old")
        .expect("old success resolution attempt");
    assert!(!old_resolution.resolved);

    insert_run(
        &db,
        "run-success-other-work",
        "completed",
        "backfill",
        "legacy-dependency-backfill:other",
        None,
    );
    assert!(
        !resolve_terminal_failure_for_run(&db, PROJECT_ID, "run-success-other-work")
            .expect("different work resolution attempt")
            .resolved
    );

    insert_run(
        &db,
        "run-success-other-kind",
        "completed",
        "dependency-verify",
        WORK_KEY,
        None,
    );
    assert!(
        !resolve_terminal_failure_for_run(&db, PROJECT_ID, "run-success-other-kind")
            .expect("different kind resolution attempt")
            .resolved
    );

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 1, 'restore', '2026-08-22T00:00:00.000Z')",
            params![SECOND_EPOCH_ID, PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed a second epoch");
    insert_run_for_context(
        &db,
        "run-success-other-epoch",
        PROJECT_ID,
        Some(SECOND_EPOCH_ID),
        "completed",
        "backfill",
        Some(WORK_KEY),
        None,
    );
    assert!(
        !resolve_terminal_failure_for_run(&db, PROJECT_ID, "run-success-other-epoch")
            .expect("different epoch resolution attempt")
            .resolved
    );

    insert_run(
        &db,
        "run-success-new",
        "completed",
        "backfill",
        WORK_KEY,
        None,
    );
    let new_resolution = resolve_terminal_failure_for_run(&db, PROJECT_ID, "run-success-new")
        .expect("new success resolution");
    assert!(new_resolution.resolved);

    let (old_created_at, failure_created_at, new_created_at): (String, String, String) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT
                    (SELECT created_at FROM narrative_extraction_runs WHERE id = 'run-success-old'),
                    (SELECT created_at FROM narrative_extraction_runs WHERE id = 'run-failure'),
                    (SELECT created_at FROM narrative_extraction_runs WHERE id = 'run-success-new')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(Into::into)
        })
        .expect("read durable run order");
    assert_eq!(old_created_at, failure_created_at);
    assert_eq!(failure_created_at, new_created_at);
}

#[test]
fn resolution_ignores_rowid_reinsert_and_uses_canonical_run_order() {
    let db = fixture_db();
    insert_run(
        &db,
        "run-reinsert-failure",
        "failed",
        "backfill",
        WORK_KEY,
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
    );
    project_terminal_failure_for_run(
        &db,
        PROJECT_ID,
        "run-reinsert-failure",
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: restore order",
    )
    .expect("project failure");
    insert_run(
        &db,
        "run-reinsert-success",
        "completed",
        "backfill",
        WORK_KEY,
        None,
    );

    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM narrative_extraction_runs WHERE id = 'run-reinsert-failure'",
            [],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, run_kind, semantic_epoch_id,
                 work_key, terminal_reason_code)
             VALUES ('run-reinsert-failure', ?1, 'maintenance', '{}', '{}', 'digest',
                     'failed', '{}', '2026-08-22T00:00:00.000Z', 'backfill', ?2, ?3,
                     'NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION')",
            params![PROJECT_ID, EPOCH_ID, WORK_KEY],
        )?;
        Ok(())
    })
    .expect("restore failure Run with its durable identity and timestamp");

    assert!(
        resolve_terminal_failure_for_run(&db, PROJECT_ID, "run-reinsert-success")
            .expect("resolve after logical restore")
            .resolved,
        "a rowid-only resolver would mistake the restored failure for the newer Run"
    );
}
