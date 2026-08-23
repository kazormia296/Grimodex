//! Additional SCHEMA 32 C2-ZB migration atomicity and target-reuse coverage.
//!
//! The public RED contract remains in
//! `narrative_c2zb_application_rekey.rs`.  These cases specifically exercise
//! failures after the C2-ZB marker write, preflight across multiple projects,
//! and a pre-existing target Edge with no Finding history.

use std::path::Path;

use grimodex_db::narrative_extraction::{
    stable_finding_identity, BUNDLED_FINDING_RULE_ID, BUNDLED_FINDING_RULE_VERSION,
};
use grimodex_db::Database;
use rusqlite::{params, Connection};

const SCHEMA_31: i32 = 31;
const SCHEMA_33: i32 = 33;
const MARKER: &str = "narrative-c2-application-rekey-v32";
const RUN_KIND: &str = "narrative-extraction-run";
const APPLICATION_KIND: &str = "application";
const SEEDED_AT: &str = "2026-08-24T00:00:00.000Z";

fn rewound_database() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open in-memory database");
    db.migrate().expect("materialise current schema");
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM schema_data_migrations WHERE migration_id = ?1",
            [MARKER],
        )?;
        conn.pragma_update(None, "user_version", SCHEMA_31)?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("rewind current fixture to SCHEMA 31");
    db
}

fn seed_project(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    application_id: &str,
    commit_id: &str,
    edge_id: &str,
    source_identity: &str,
    token: &str,
    with_history: bool,
    with_existing_target: bool,
) -> anyhow::Result<()> {
    let epoch_id = format!("{project_id}-epoch-0");
    conn.execute(
        "INSERT INTO projects (id, title) VALUES (?1, 'C2-ZB atomicity fixture')",
        [project_id],
    )?;
    conn.execute(
        "INSERT INTO narrative_semantic_epochs
            (id, project_id, epoch_number, reason, created_at)
         VALUES (?1, ?2, 0, 'initial', ?3)",
        params![epoch_id, project_id, SEEDED_AT],
    )?;
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, completed_at, version, run_kind,
             semantic_epoch_id, work_key)
         VALUES (?1, ?2, 'maintenance', '{}', '{}', 'c2zb-atomicity', 'completed',
                 '{}', ?3, ?3, 0, 'backfill', ?4, 'legacy-dependency-backfill:v2')",
        params![run_id, project_id, SEEDED_AT, epoch_id],
    )?;
    conn.execute(
        "INSERT INTO narrative_apply_commits
            (id, project_id, run_id, request_id, plan_digest, status, created_at, version)
         VALUES (?1, ?2, ?3, ?4, 'c2zb-plan', 'committed', ?5, 0)",
        params![
            commit_id,
            project_id,
            run_id,
            format!("request-{application_id}"),
            SEEDED_AT
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_applications
            (id, commit_id, proposal_id, revision_id, applied_entity_kind,
             applied_entity_id, created_at)
         VALUES (?1, ?2, ?3, ?4, 'codex_entry', ?5, ?6)",
        params![
            application_id,
            commit_id,
            format!("proposal-{application_id}"),
            format!("revision-{application_id}"),
            format!("entry-{application_id}"),
            SEEDED_AT
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_projection_dependencies
            (application_id, source_kind, source_key, observed_revision_token, propagation)
         VALUES (?1, 'scene-body', ?2, ?3, 'freshness-only')",
        params![application_id, source_identity, token],
    )?;
    conn.execute(
        "INSERT INTO narrative_dependency_edges
            (id, project_id, consumer_kind, consumer_key, source_object_identity,
             read_set_json, generated_by_transaction_id, created_at, owning_run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'old-transaction', ?7, ?4)",
        params![
            edge_id,
            project_id,
            RUN_KIND,
            run_id,
            source_identity,
            format!("[\"{token}\"]"),
            SEEDED_AT
        ],
    )?;

    conn.execute(
        "INSERT INTO narrative_dependency_edge_states
            (edge_id, project_id, evidence_freshness, reason_code, build_action,
             evaluated_at_epoch_id, evaluated_at)
         VALUES (?1, ?2, 'source-missing', 'source-missing', 'rebuild-required', ?3, ?4)",
        params![edge_id, project_id, epoch_id, SEEDED_AT],
    )?;
    conn.execute(
        "INSERT INTO narrative_consumer_freshness
            (project_id, consumer_kind, consumer_key, evidence_freshness,
             build_action, semantic_epoch_id, last_evaluated_run_id,
             dependency_set_digest, updated_at)
         VALUES (?1, ?2, ?3, 'source-missing', 'rebuild-required', ?4, ?3,
                 'old-set', ?5)",
        params![project_id, RUN_KIND, run_id, epoch_id, SEEDED_AT],
    )?;

    if with_history {
        let finding_key = format!("{RUN_KIND}:{run_id}");
        let finding_identity = stable_finding_identity(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            edge_id,
        )?;
        conn.execute(
            "INSERT INTO narrative_maintenance_finding_observations
                (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
                 reason_code, evidence_freshness_snapshot, material_basis_digest,
                 observed_at, finding_identity, rule_id, rule_version, observation_digest)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'source-missing', 'source-missing',
                     'old-material', ?7, ?8, ?9, ?10, 'old-observation')",
            params![
                format!("observation-{edge_id}"),
                project_id,
                run_id,
                epoch_id,
                edge_id,
                finding_key,
                SEEDED_AT,
                finding_identity,
                BUNDLED_FINDING_RULE_ID,
                BUNDLED_FINDING_RULE_VERSION
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_maintenance_finding_lifecycle
                (id, project_id, finding_identity, finding_key, rule_id, rule_version,
                 lifecycle_state, observation_digest, material_basis_digest, run_id,
                 semantic_epoch_id, observed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'recurring', 'old-observation',
                     'old-material', ?7, ?8, ?9)",
            params![
                format!("lifecycle-{edge_id}"),
                project_id,
                finding_identity,
                finding_key,
                BUNDLED_FINDING_RULE_ID,
                BUNDLED_FINDING_RULE_VERSION,
                run_id,
                epoch_id,
                SEEDED_AT
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_maintenance_attention
                (project_id, finding_key, finding_identity, identity_resolution_status,
                 disposition, material_basis_digest, snoozed_until, set_at, actor_id,
                 request_id, payload_digest, reason, version)
             VALUES (?1, ?2, ?3, 'resolved', 'dismissed', 'unmatched-material', NULL, ?4,
                     'human-author', 'human-request', 'human-payload', 'human-reason', 7)",
            params![project_id, finding_key, finding_identity, SEEDED_AT],
        )?;
    }

    if with_existing_target {
        let target_edge_id = format!("{edge_id}-target");
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key, source_object_identity,
                 read_set_json, generated_by_transaction_id, created_at, owning_run_id)
             VALUES (?1, ?2, 'application', ?3, ?4, ?5, 'target-transaction',
                     'target-created', ?6)",
            params![
                target_edge_id,
                project_id,
                application_id,
                source_identity,
                format!("[\"{token}\"]"),
                run_id
            ],
        )?;
    }
    Ok(())
}

fn seed_fresh_backfill_owner(
    conn: &Connection,
    project_id: &str,
    owner_id: &str,
) -> anyhow::Result<()> {
    let epoch_id = format!("{project_id}-epoch-0");
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, completed_at, version, run_kind,
             semantic_epoch_id, work_key)
         VALUES (?1, ?2, 'maintenance', '{}', '{}', 'c2zb-fresh-owner', 'completed',
                 '{}', ?3, ?3, 0, 'backfill', ?4, 'legacy-dependency-backfill:v3')",
        params![owner_id, project_id, SEEDED_AT, epoch_id],
    )?;
    Ok(())
}

fn assert_schema_31_without_marker(conn: &Connection, project_id: &str) -> anyhow::Result<()> {
    let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    assert_eq!(version, SCHEMA_31);
    let marker_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
        [MARKER],
        |row| row.get(0),
    )?;
    assert_eq!(marker_count, 0);
    let migration_epoch_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_semantic_epochs
          WHERE project_id = ?1 AND reason = 'migration'",
        [project_id],
        |row| row.get(0),
    )?;
    assert_eq!(migration_epoch_count, 0);
    Ok(())
}

fn add_second_exact_candidate(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    application_id: &str,
    commit_id: &str,
    edge_id: &str,
    source_identity: &str,
    token: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO narrative_apply_commits
            (id, project_id, run_id, request_id, plan_digest, status, created_at, version)
         VALUES (?1, ?2, ?3, ?4, 'c2zb-plan', 'committed', ?5, 0)",
        params![
            commit_id,
            project_id,
            run_id,
            format!("request-{application_id}"),
            SEEDED_AT
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_applications
            (id, commit_id, proposal_id, revision_id, applied_entity_kind,
             applied_entity_id, created_at)
         VALUES (?1, ?2, ?3, ?4, 'codex_entry', ?5, ?6)",
        params![
            application_id,
            commit_id,
            format!("proposal-{application_id}"),
            format!("revision-{application_id}"),
            format!("entry-{application_id}"),
            SEEDED_AT
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_projection_dependencies
            (application_id, source_kind, source_key, observed_revision_token, propagation)
         VALUES (?1, 'scene-body', ?2, ?3, 'freshness-only')",
        params![application_id, source_identity, token],
    )?;
    conn.execute(
        "INSERT INTO narrative_dependency_edges
            (id, project_id, consumer_kind, consumer_key, source_object_identity,
             read_set_json, generated_by_transaction_id, created_at, owning_run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'second-old-transaction', ?7, ?4)",
        params![
            edge_id,
            project_id,
            RUN_KIND,
            run_id,
            source_identity,
            format!("[\"{token}\"]"),
            SEEDED_AT
        ],
    )?;
    Ok(())
}

fn insert_attention(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    finding_identity: Option<&str>,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO narrative_maintenance_attention
            (project_id, finding_key, finding_identity, identity_resolution_status,
             disposition, material_basis_digest, snoozed_until, set_at, actor_id,
             request_id, payload_digest, reason, version)
         VALUES (?1, ?2, ?3, ?4, 'dismissed', 'attention-material', NULL, ?5,
                 'human-author', 'human-request', 'human-payload', 'human-reason', 7)",
        params![
            project_id,
            format!("{RUN_KIND}:{run_id}"),
            finding_identity,
            if finding_identity.is_some() {
                "resolved"
            } else {
                "legacy-unresolved"
            },
            SEEDED_AT
        ],
    )?;
    Ok(())
}

#[test]
fn checkpoint_failure_after_marker_rolls_back_every_c2zb_write_and_retry_succeeds() {
    let db = rewound_database();
    db.with_conn(|conn| {
        seed_project(
            conn,
            "c2zb-atomic-trigger",
            "c2zb-atomic-trigger-run",
            "c2zb-atomic-trigger-application",
            "c2zb-atomic-trigger-commit",
            "c2zb-atomic-trigger-edge",
            "project:scene:c2zb-atomic-trigger-scene",
            "c2zb-atomic-trigger-token",
            true,
            false,
        )?;
        conn.execute_batch(
            "CREATE TRIGGER c2zb_checkpoint_failpoint
               AFTER INSERT ON schema_data_migrations
               WHEN NEW.migration_id = 'narrative-c2-application-rekey-v32'
               BEGIN
                 DELETE FROM schema_data_migrations
                  WHERE migration_id = NEW.migration_id;
               END;",
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed post-marker checkpoint failpoint");

    db.migrate()
        .expect_err("checkpoint failure must abort the C2-ZB savepoint");
    db.with_conn(|conn| {
        assert_schema_31_without_marker(conn, "c2zb-atomic-trigger")?;
        let old_edge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE id = 'c2zb-atomic-trigger-edge'
                AND consumer_kind = ?1 AND consumer_key = 'c2zb-atomic-trigger-run'",
            [RUN_KIND],
            |row| row.get(0),
        )?;
        assert_eq!(old_edge_count, 1);
        let old_finding_key_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_finding_observations
              WHERE project_id = 'c2zb-atomic-trigger'
                AND finding_key = 'narrative-extraction-run:c2zb-atomic-trigger-run'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(old_finding_key_count, 1);
        let old_lifecycle_key_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_finding_lifecycle
              WHERE project_id = 'c2zb-atomic-trigger'
                AND finding_key = 'narrative-extraction-run:c2zb-atomic-trigger-run'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(old_lifecycle_key_count, 1);
        let old_attention_key_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_attention
              WHERE project_id = 'c2zb-atomic-trigger'
                AND finding_key = 'narrative-extraction-run:c2zb-atomic-trigger-run'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(old_attention_key_count, 1);
        let old_state_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edge_states
              WHERE edge_id = 'c2zb-atomic-trigger-edge'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(old_state_count, 1);
        let old_freshness_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_consumer_freshness
              WHERE project_id = 'c2zb-atomic-trigger'
                AND consumer_kind = ?1 AND consumer_key = 'c2zb-atomic-trigger-run'",
            [RUN_KIND],
            |row| row.get(0),
        )?;
        assert_eq!(old_freshness_count, 1);
        let application_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = 'c2zb-atomic-trigger' AND consumer_kind = 'application'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(application_count, 0);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify post-marker rollback");

    db.with_conn(|conn| {
        conn.execute_batch("DROP TRIGGER c2zb_checkpoint_failpoint")?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("remove checkpoint failpoint");
    db.migrate().expect("retry after checkpoint failure");
    db.with_conn(|conn| {
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, SCHEMA_33);
        let marker_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
            [MARKER],
            |row| row.get(0),
        )?;
        assert_eq!(marker_count, 1);
        let application_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = 'c2zb-atomic-trigger' AND consumer_kind = 'application'
                AND consumer_key = 'c2zb-atomic-trigger-application'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(application_count, 1);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify post-marker retry");
}

#[test]
fn release_failure_rolls_back_c2zb_savepoint_and_leaves_connection_autocommit() {
    let db = rewound_database();
    db.with_conn(|conn| {
        seed_project(
            conn,
            "c2zb-release-failure",
            "c2zb-release-failure-run",
            "c2zb-release-failure-application",
            "c2zb-release-failure-commit",
            "c2zb-release-failure-edge",
            "project:scene:c2zb-release-failure-scene",
            "c2zb-release-failure-token",
            false,
            false,
        )?;
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.execute_batch(
            "CREATE TABLE c2zb_deferred_release_failpoint (
                 id TEXT PRIMARY KEY,
                 edge_id TEXT NOT NULL,
                 FOREIGN KEY(edge_id) REFERENCES narrative_dependency_edges(id)
                     DEFERRABLE INITIALLY DEFERRED
             );
             CREATE TRIGGER c2zb_release_failpoint
               AFTER INSERT ON schema_data_migrations
               WHEN NEW.migration_id = 'narrative-c2-application-rekey-v32'
               BEGIN
                 INSERT INTO c2zb_deferred_release_failpoint(id, edge_id)
                 VALUES ('orphan', 'missing-edge');
               END;",
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed deferred-FK RELEASE failpoint");

    db.migrate()
        .expect_err("deferred foreign key must fail while releasing C2-ZB savepoint");
    db.with_conn(|conn| {
        assert!(
            conn.is_autocommit(),
            "failed RELEASE must unwind the savepoint"
        );
        assert_schema_31_without_marker(conn, "c2zb-release-failure")?;
        let old_edge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE id = 'c2zb-release-failure-edge'
                AND consumer_kind = ?1
                AND consumer_key = 'c2zb-release-failure-run'",
            [RUN_KIND],
            |row| row.get(0),
        )?;
        assert_eq!(old_edge_count, 1);
        let application_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = 'c2zb-release-failure'
                AND consumer_kind = 'application'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(application_count, 0);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify deferred-FK RELEASE rollback");

    db.with_conn(|conn| {
        conn.execute_batch(
            "DROP TRIGGER c2zb_release_failpoint;
             DROP TABLE c2zb_deferred_release_failpoint;",
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("remove deferred-FK RELEASE failpoint");
    db.migrate().expect("retry after RELEASE failure");
    db.with_conn(|conn| {
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, SCHEMA_33);
        let marker_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
            [MARKER],
            |row| row.get(0),
        )?;
        assert_eq!(marker_count, 1);
        let application_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = 'c2zb-release-failure'
                AND consumer_kind = 'application'
                AND consumer_key = 'c2zb-release-failure-application'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(application_count, 1);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify retry after RELEASE failure");
}

#[test]
fn all_projects_are_preflighted_before_a_safe_project_is_written() {
    let db = rewound_database();
    db.with_conn(|conn| {
        seed_project(
            conn,
            "c2zb-safe-first",
            "c2zb-safe-first-run",
            "c2zb-safe-first-application",
            "c2zb-safe-first-commit",
            "c2zb-safe-first-edge",
            "project:scene:c2zb-safe-first-scene",
            "c2zb-safe-first-token",
            false,
            false,
        )?;
        seed_project(
            conn,
            "c2zb-unsafe-second",
            "c2zb-unsafe-second-run",
            "c2zb-unsafe-second-application",
            "c2zb-unsafe-second-commit",
            "c2zb-unsafe-second-edge",
            "project:scene:c2zb-unsafe-second-scene",
            "c2zb-unsafe-second-token",
            false,
            false,
        )?;
        conn.execute(
            "DELETE FROM narrative_projection_dependencies
              WHERE application_id = 'c2zb-unsafe-second-application'",
            [],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed safe and unsafe projects");

    db.migrate()
        .expect_err("unsafe later project must reject the whole workspace");
    db.with_conn(|conn| {
        assert_schema_31_without_marker(conn, "c2zb-safe-first")?;
        assert_schema_31_without_marker(conn, "c2zb-unsafe-second")?;
        for (project_id, edge_id, run_id, application_id) in [
            (
                "c2zb-safe-first",
                "c2zb-safe-first-edge",
                "c2zb-safe-first-run",
                "c2zb-safe-first-application",
            ),
            (
                "c2zb-unsafe-second",
                "c2zb-unsafe-second-edge",
                "c2zb-unsafe-second-run",
                "c2zb-unsafe-second-application",
            ),
        ] {
            let old_edge_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edges
                  WHERE project_id = ?1 AND id = ?2
                    AND consumer_kind = ?3 AND consumer_key = ?4",
                params![project_id, edge_id, RUN_KIND, run_id],
                |row| row.get(0),
            )?;
            assert_eq!(old_edge_count, 1, "old Edge must survive for {project_id}");
            let application_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edges
                  WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
                params![project_id, APPLICATION_KIND, application_id],
                |row| row.get(0),
            )?;
            assert_eq!(application_count, 0, "safe-first writes must roll back");
        }
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify multi-project preflight rollback");
}

#[test]
fn matching_pre_existing_application_target_with_different_fresh_owner_is_reused() {
    let db = rewound_database();
    db.with_conn(|conn| {
        seed_project(
            conn,
            "c2zb-existing-target",
            "c2zb-existing-target-run",
            "c2zb-existing-target-application",
            "c2zb-existing-target-commit",
            "c2zb-existing-target-edge",
            "project:scene:c2zb-existing-target-scene",
            "c2zb-existing-target-token",
            false,
            true,
        )?;
        seed_fresh_backfill_owner(
            conn,
            "c2zb-existing-target",
            "c2zb-existing-target-fresh-owner",
        )?;
        conn.execute(
            "UPDATE narrative_dependency_edges
                SET owning_run_id = 'c2zb-existing-target-fresh-owner'
              WHERE id = 'c2zb-existing-target-edge-target'",
            [],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed matching existing target");

    db.migrate()
        .expect("existing target with no history is safe");
    db.with_conn(|conn| {
        let target: (String, String, String, String, Option<String>) = conn.query_row(
            "SELECT id, generated_by_transaction_id, created_at, read_set_json, owning_run_id
               FROM narrative_dependency_edges
              WHERE project_id = 'c2zb-existing-target'
                AND consumer_kind = 'application'
                AND consumer_key = 'c2zb-existing-target-application'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        assert_eq!(target.0, "c2zb-existing-target-edge-target");
        assert_eq!(target.1, "target-transaction");
        assert_eq!(target.2, "target-created");
        assert_eq!(target.3, "[\"c2zb-existing-target-token\"]");
        assert_eq!(
            target.4.as_deref(),
            Some("c2zb-existing-target-fresh-owner")
        );
        let old_edge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE id = 'c2zb-existing-target-edge'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(old_edge_count, 0);
        let derived_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_consumer_freshness
              WHERE project_id = 'c2zb-existing-target'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(derived_count, 0);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify existing target reuse");
}

#[test]
fn dangling_existing_application_edge_rejects_before_any_c2zb_write() {
    let db = rewound_database();
    db.with_conn(|conn| {
        seed_project(
            conn,
            "c2zb-dangling-application",
            "c2zb-dangling-application-run",
            "c2zb-dangling-application-id",
            "c2zb-dangling-application-commit",
            "c2zb-dangling-application-edge",
            "project:scene:c2zb-dangling-application-scene",
            "c2zb-dangling-application-token",
            false,
            false,
        )?;
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key,
                 source_object_identity, read_set_json, generated_by_transaction_id,
                 created_at, owning_run_id)
             VALUES ('c2zb-dangling-application-edge-2',
                     'c2zb-dangling-application', 'application',
                     'c2zb-missing-application-id',
                     'project:scene:c2zb-dangling-application-scene',
                     '[\"c2zb-dangling-application-token\"]',
                     'application-transaction', ?1,
                     'c2zb-dangling-application-run')",
            [SEEDED_AT],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed dangling Application Edge");

    db.migrate()
        .expect_err("dangling Application provenance must fail closed");
    db.with_conn(|conn| {
        assert_schema_31_without_marker(conn, "c2zb-dangling-application")?;
        let application_edge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE id = 'c2zb-dangling-application-edge-2'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(application_edge_count, 1);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify dangling Application rollback");
}

#[test]
fn foreign_application_commit_rejects_before_any_c2zb_write() {
    let db = rewound_database();
    db.with_conn(|conn| {
        seed_project(
            conn,
            "c2zb-foreign-application-project",
            "c2zb-foreign-application-run",
            "c2zb-foreign-application-id",
            "c2zb-foreign-application-commit",
            "c2zb-foreign-application-edge",
            "project:scene:c2zb-foreign-application-scene",
            "c2zb-foreign-application-token",
            false,
            false,
        )?;
        seed_project(
            conn,
            "c2zb-foreign-application-owner",
            "c2zb-foreign-application-owner-run",
            "c2zb-foreign-application-owner-id",
            "c2zb-foreign-application-owner-commit",
            "c2zb-foreign-application-owner-edge",
            "project:scene:c2zb-foreign-application-owner-scene",
            "c2zb-foreign-application-owner-token",
            false,
            false,
        )?;
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key,
                 source_object_identity, read_set_json, generated_by_transaction_id,
                 created_at, owning_run_id)
             VALUES ('c2zb-foreign-application-edge-2',
                     'c2zb-foreign-application-project', 'application',
                     'c2zb-foreign-application-owner-id',
                     'project:scene:c2zb-foreign-application-scene',
                     '[\"c2zb-foreign-application-token\"]',
                     'application-transaction', ?1,
                     'c2zb-foreign-application-run')",
            [SEEDED_AT],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed foreign-project Application Edge");

    db.migrate()
        .expect_err("foreign Application provenance must fail closed");
    db.with_conn(|conn| {
        assert_schema_31_without_marker(conn, "c2zb-foreign-application-project")?;
        let application_edge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE id = 'c2zb-foreign-application-edge-2'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(application_edge_count, 1);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify foreign Application rollback");
}

#[test]
fn mismatched_existing_application_projection_dependency_rejects_atomically() {
    let db = rewound_database();
    db.with_conn(|conn| {
        seed_project(
            conn,
            "c2zb-mismatched-application",
            "c2zb-mismatched-application-run",
            "c2zb-mismatched-application-id",
            "c2zb-mismatched-application-commit",
            "c2zb-mismatched-application-edge",
            "project:scene:c2zb-mismatched-application-scene",
            "c2zb-mismatched-application-token",
            false,
            false,
        )?;
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key,
                 source_object_identity, read_set_json, generated_by_transaction_id,
                 created_at, owning_run_id)
             VALUES ('c2zb-mismatched-application-edge-2',
                     'c2zb-mismatched-application', 'application',
                     'c2zb-mismatched-application-id',
                     'project:scene:c2zb-mismatched-application-other-scene',
                     '[\"c2zb-mismatched-application-other-token\"]',
                     'application-transaction', ?1,
                     'c2zb-mismatched-application-run')",
            [SEEDED_AT],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed mismatched Application dependency Edge");

    db.migrate()
        .expect_err("mismatched Application dependency must fail closed");
    db.with_conn(|conn| {
        assert_schema_31_without_marker(conn, "c2zb-mismatched-application")?;
        let application_edge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE id = 'c2zb-mismatched-application-edge-2'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(application_edge_count, 1);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify mismatched Application rollback");
}

#[test]
fn non_null_attention_identity_rehomes_only_its_exact_edge_when_a_run_has_two_edges() {
    let db = rewound_database();
    db.with_conn(|conn| {
        seed_project(
            conn,
            "c2zb-attention-exact",
            "c2zb-attention-exact-run",
            "c2zb-attention-exact-application-a",
            "c2zb-attention-exact-commit-a",
            "c2zb-attention-exact-edge-a",
            "project:scene:c2zb-attention-exact-scene-a",
            "c2zb-attention-exact-token-a",
            false,
            false,
        )?;
        add_second_exact_candidate(
            conn,
            "c2zb-attention-exact",
            "c2zb-attention-exact-run",
            "c2zb-attention-exact-application-b",
            "c2zb-attention-exact-commit-b",
            "c2zb-attention-exact-edge-b",
            "project:scene:c2zb-attention-exact-scene-b",
            "c2zb-attention-exact-token-b",
        )?;
        let identity = stable_finding_identity(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            "c2zb-attention-exact-edge-a",
        )?;
        insert_attention(
            conn,
            "c2zb-attention-exact",
            "c2zb-attention-exact-run",
            Some(&identity),
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed two exact edges under one Run");

    db.migrate()
        .expect("identity-bearing Attention must select one exact candidate");
    db.with_conn(|conn| {
        let attention_key: String = conn.query_row(
            "SELECT finding_key FROM narrative_maintenance_attention
              WHERE project_id = 'c2zb-attention-exact'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(
            attention_key,
            "application:c2zb-attention-exact-application-a"
        );
        let finding_history_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_finding_observations
              WHERE project_id = 'c2zb-attention-exact'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(finding_history_count, 0);
        let application_edges: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = 'c2zb-attention-exact'
                AND consumer_kind = 'application'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(application_edges, 2);
        let second_edge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = 'c2zb-attention-exact'
                AND consumer_kind = 'application'
                AND consumer_key = 'c2zb-attention-exact-application-b'
                AND source_object_identity = 'project:scene:c2zb-attention-exact-scene-b'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(second_edge_count, 1);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify exact Attention re-home");
}

#[test]
fn null_attention_identity_with_multiple_exact_edges_fails_closed() {
    let db = rewound_database();
    db.with_conn(|conn| {
        seed_project(
            conn,
            "c2zb-attention-null",
            "c2zb-attention-null-run",
            "c2zb-attention-null-application-a",
            "c2zb-attention-null-commit-a",
            "c2zb-attention-null-edge-a",
            "project:scene:c2zb-attention-null-scene-a",
            "c2zb-attention-null-token-a",
            false,
            false,
        )?;
        add_second_exact_candidate(
            conn,
            "c2zb-attention-null",
            "c2zb-attention-null-run",
            "c2zb-attention-null-application-b",
            "c2zb-attention-null-commit-b",
            "c2zb-attention-null-edge-b",
            "project:scene:c2zb-attention-null-scene-b",
            "c2zb-attention-null-token-b",
        )?;
        insert_attention(conn, "c2zb-attention-null", "c2zb-attention-null-run", None)?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed NULL-identity Attention fan-out");

    db.migrate()
        .expect_err("NULL-identity Attention with multiple candidates is ambiguous");
    db.with_conn(|conn| {
        assert_schema_31_without_marker(conn, "c2zb-attention-null")?;
        let old_attention_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_attention
              WHERE project_id = 'c2zb-attention-null'
                AND finding_key = 'narrative-extraction-run:c2zb-attention-null-run'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(old_attention_count, 1);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify NULL-identity ambiguity rollback");
}
