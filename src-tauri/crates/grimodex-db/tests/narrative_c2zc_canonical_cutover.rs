//! C2-ZC public cutover contract (RED on the frozen C2-ZB base).
//!
//! These tests intentionally describe the externally visible boundary before
//! the canonical-authority implementation exists.  They do not exercise a
//! private helper or a schema re-key: the only allowed transition is a
//! runtime-owned cutover after all durable workspace evidence and an explicit
//! scheduler-liveness proof are present.

use std::path::Path;

use grimodex_db::narrative_extraction::{
    canonical_application_freshness, cut_over_workspace_freshness,
    inspect_workspace_cutover_readiness_with_liveness, CanonicalFreshnessAuthority,
    ReadinessState, SchedulerLivenessEvidence, C2_ZC_CUTOVER_MIGRATION_ID,
};
use grimodex_db::Database;
use rusqlite::{params, Connection};

const PROJECT_ID: &str = "project-c2zc";
const EPOCH_ID: &str = "epoch-c2zc";
const APPLICATION_ID: &str = "application-c2zc";
const SOURCE_IDENTITY: &str = "project:scene:scene-c2zc";
const NOW: &str = "2026-08-24T00:00:00.000Z";

fn fixture_db() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-ZC fixture')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', ?3)",
            params![EPOCH_ID, PROJECT_ID, NOW],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed project");
    db
}

fn scheduler_evidence(project_ids: &[&str]) -> SchedulerLivenessEvidence {
    SchedulerLivenessEvidence {
        scheduler_instance_id: "scheduler-c2zc-red".to_string(),
        observed_at: NOW.to_string(),
        project_ids: project_ids.iter().map(|id| (*id).to_string()).collect(),
    }
}

#[test]
fn database_only_liveness_never_becomes_cutover_evidence() {
    let db = fixture_db();

    db.with_conn(|conn| {
        let durable = inspect_workspace_cutover_readiness_with_liveness(conn, None)?;
        assert!(!durable.ready);
        assert_eq!(durable.state, ReadinessState::Incomplete);
        assert!(durable
            .reasons
            .iter()
            .any(|reason| reason == "scheduler-liveness-evidence-required"));
        Ok::<_, anyhow::Error>(())
    })
    .expect("readiness report");
}

#[test]
fn cutover_refuses_incomplete_workspace_before_any_authority_marker() {
    let db = fixture_db();

    let error = db
        .with_conn(|conn| {
            cut_over_workspace_freshness(conn, &scheduler_evidence(&[PROJECT_ID]))
                .expect_err("incomplete durable gates must block C2-ZC")
                .into()
        })
        .expect("read cutover error");

    assert!(error.to_string().contains("NEX_C2ZC_CUTOVER_NOT_READY"));
    db.with_conn(|conn| {
        let marker_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
            [C2_ZC_CUTOVER_MIGRATION_ID],
            |row| row.get(0),
        )?;
        assert_eq!(marker_count, 0);
        Ok::<_, anyhow::Error>(())
    })
    .expect("cutover must not write a marker when blocked");
}

#[test]
fn canonical_read_has_no_legacy_fallback_after_generic_cutover() {
    let db = fixture_db();

    db.with_conn(|conn| {
        // The RED fixture deliberately calls the public cutover API only
        // after a test-owned durable fixture has satisfied the full contract.
        seed_cutover_ready_application(conn)?;
        cut_over_workspace_freshness(conn, &scheduler_evidence(&[PROJECT_ID]))?;

        conn.execute(
            "UPDATE narrative_projection_freshness
                SET status = 'source-missing'
              WHERE application_id = ?1",
            [APPLICATION_ID],
        )?;
        let read = canonical_application_freshness(conn, PROJECT_ID, APPLICATION_ID)?
            .expect("Generic Consumer Freshness row is the canonical read");
        assert_eq!(read.authority, CanonicalFreshnessAuthority::GenericConsumerFreshness);
        assert_eq!(read.evidence_freshness, "fresh");
        Ok::<_, anyhow::Error>(())
    })
    .expect("canonical read");
}

#[test]
fn canonical_read_fails_closed_when_generic_evidence_is_missing() {
    let db = fixture_db();

    db.with_conn(|conn| {
        seed_cutover_ready_application(conn)?;
        cut_over_workspace_freshness(conn, &scheduler_evidence(&[PROJECT_ID]))?;
        conn.execute(
            "DELETE FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = 'application'
                AND consumer_key = ?2",
            params![PROJECT_ID, APPLICATION_ID],
        )?;

        let error = canonical_application_freshness(conn, PROJECT_ID, APPLICATION_ID)
            .expect_err("missing Generic evidence must not fall back to Legacy");
        assert!(error
            .to_string()
            .contains("NEX_C2ZC_GENERIC_FRESHNESS_MISSING"));
        Ok::<_, anyhow::Error>(())
    })
    .expect("fail-closed canonical read");
}

fn seed_cutover_ready_application(conn: &Connection) -> anyhow::Result<()> {
    // This helper is intentionally incomplete on the frozen base: the RED
    // tests make the expected public C2-ZC contract explicit and the
    // implementation will own the exact current-contract evidence checks.
    conn.execute(
        "INSERT INTO narrative_apply_commits
            (id, project_id, run_id, request_id, plan_digest, status, created_at)
         VALUES ('commit-c2zc', ?1, NULL, 'request-c2zc', 'sha256:c2zc',
                 'committed', ?2)",
        params![PROJECT_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_applications
            (id, commit_id, proposal_id, revision_id, applied_entity_kind,
             applied_entity_id, created_at)
         VALUES (?1, 'commit-c2zc', 'proposal-c2zc', 'revision-c2zc',
                 'codex-entry', 'entry-c2zc', ?2)",
        params![APPLICATION_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_projection_freshness
            (application_id, status, reason_json, version, updated_at)
         VALUES (?1, 'fresh', NULL, 0, ?2)",
        params![APPLICATION_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_consumer_freshness
            (project_id, consumer_kind, consumer_key, evidence_freshness,
             build_action, semantic_epoch_id, last_evaluated_run_id,
             dependency_set_digest, updated_at)
         VALUES (?1, 'application', ?2, 'fresh', 'none', ?3, NULL,
                 'sha256:c2zc', ?4)",
        params![PROJECT_ID, APPLICATION_ID, EPOCH_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_dependency_edges
            (id, project_id, consumer_kind, consumer_key, source_object_identity,
             read_set_json, created_at)
         VALUES ('edge-c2zc', ?1, 'application', ?2, ?3,
                 '[\"token-c2zc\"]', ?4)",
        params![PROJECT_ID, APPLICATION_ID, SOURCE_IDENTITY, NOW],
    )?;
    Ok(())
}
