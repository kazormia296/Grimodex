//! C2-ZB application re-key migration contract.
//!
//! These are deliberately public-entry-point tests.  The fixture is first
//! materialised with the current schema, then put back at SCHEMA 31 and fed to
//! `Database::migrate()`.  The parent (SCHEMA 31) therefore compiles this
//! suite, but cannot satisfy the behaviour until the C2-ZB migration owns
//! SCHEMA 32.

use std::path::Path;

use grimodex_db::narrative_extraction::{
    bootstrap_legacy_dependency_backfill_for_project, material_basis_digest, observation_digest,
    stable_finding_identity, LegacyBackfillBootstrapOutcome, MaterialBasisInput,
    ObservationDigestInput, BUNDLED_FINDING_RULE_ID, BUNDLED_FINDING_RULE_VERSION,
};
use grimodex_db::Database;
use rusqlite::{params, Connection};

const PREVIOUS_SCHEMA: i32 = 31;
const TARGET_SCHEMA: i32 = 34;
const APPLICATION_REKEY_MARKER: &str = "narrative-c2-application-rekey-v32";
const RUN_CONSUMER_KIND: &str = "narrative-extraction-run";
const APPLICATION_CONSUMER_KIND: &str = "application";
const BACKFILL_V3_WORK_KEY: &str = "legacy-dependency-backfill:v3";
const SEEDED_AT: &str = "2026-08-24T00:00:00.000Z";
const FINDING_REASON_CODE: &str = "source-missing";
const FINDING_EVIDENCE_FRESHNESS: &str = "source-missing";

#[derive(Clone, Copy)]
struct ProjectSpec<'a> {
    project_id: &'a str,
    run_id: &'a str,
    application_id: &'a str,
    commit_id: &'a str,
    edge_id: &'a str,
    source_identity: &'a str,
    revision_token: &'a str,
}

const EXACT: ProjectSpec<'static> = ProjectSpec {
    project_id: "c2zb-project-exact",
    run_id: "c2zb-run-exact",
    application_id: "c2zb-application-exact",
    commit_id: "c2zb-commit-exact",
    edge_id: "c2zb-edge-exact",
    source_identity: "project:scene:c2zb-scene-exact",
    revision_token: "c2zb-token-exact",
};

fn current_db_rewound_to_schema_31() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open in-memory database");
    db.migrate().expect("materialise the current schema");
    db.with_conn(|conn| {
        // The literal is intentionally future-facing: the parent does not
        // know it yet, while a retry after a marker failpoint must remove any
        // prerelease row before exercising the real migration.
        conn.execute(
            "DELETE FROM schema_data_migrations WHERE migration_id = ?1",
            [APPLICATION_REKEY_MARKER],
        )?;
        conn.pragma_update(None, "user_version", PREVIOUS_SCHEMA)?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("rewind current fixture to SCHEMA 31");
    db
}

fn seed_project(
    conn: &Connection,
    spec: ProjectSpec<'_>,
    with_history: bool,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO projects (id, title) VALUES (?1, 'C2-ZB fixture')",
        [spec.project_id],
    )?;
    let epoch_id = format!("{}-epoch-0", spec.project_id);
    conn.execute(
        "INSERT INTO narrative_semantic_epochs
            (id, project_id, epoch_number, reason, created_at)
         VALUES (?1, ?2, 0, 'initial', ?3)",
        params![epoch_id, spec.project_id, SEEDED_AT],
    )?;
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, completed_at, version, run_kind,
             semantic_epoch_id, work_key)
         VALUES (?1, ?2, 'maintenance', '{}', '{}', 'c2zb-spec', 'completed',
                 '{}', ?3, ?3, 0, 'backfill', ?4,
                 'legacy-dependency-backfill:v2')",
        params![spec.run_id, spec.project_id, SEEDED_AT, epoch_id],
    )?;
    conn.execute(
        "INSERT INTO narrative_apply_commits
            (id, project_id, run_id, request_id, plan_digest, status, created_at, version)
         VALUES (?1, ?2, ?3, ?4, 'c2zb-plan', 'committed', ?5, 0)",
        params![
            spec.commit_id,
            spec.project_id,
            spec.run_id,
            format!("request-{}", spec.application_id),
            SEEDED_AT
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_applications
            (id, commit_id, proposal_id, revision_id, applied_entity_kind,
             applied_entity_id, created_at)
         VALUES (?1, ?2, ?3, ?4, 'codex_entry', ?5, ?6)",
        params![
            spec.application_id,
            spec.commit_id,
            format!("proposal-{}", spec.application_id),
            format!("revision-{}", spec.application_id),
            format!("entry-{}", spec.application_id),
            SEEDED_AT
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_projection_dependencies
            (application_id, source_kind, source_key, observed_revision_token, propagation)
         VALUES (?1, 'scene-body', ?2, ?3, 'freshness-only')",
        params![
            spec.application_id,
            spec.source_identity,
            spec.revision_token
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_dependency_edges
            (id, project_id, consumer_kind, consumer_key, source_object_identity,
             read_set_json, generated_by_transaction_id, created_at, owning_run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'c2zb-generated', ?7, ?4)",
        params![
            spec.edge_id,
            spec.project_id,
            RUN_CONSUMER_KIND,
            spec.run_id,
            spec.source_identity,
            format!("[\"{}\"]", spec.revision_token),
            SEEDED_AT
        ],
    )?;
    if with_history {
        seed_finding_history(
            conn,
            spec,
            &epoch_id,
            spec.edge_id,
            RUN_CONSUMER_KIND,
            spec.run_id,
        )?;
    }
    Ok(())
}

fn seed_finding_history(
    conn: &Connection,
    spec: ProjectSpec<'_>,
    epoch_id: &str,
    edge_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
) -> anyhow::Result<()> {
    let finding_key = format!("{consumer_kind}:{consumer_key}");
    let (finding_identity, observation_digest, material_basis_digest) =
        canonical_finding_values(edge_id)?;
    let observation_id = format!("observation-{edge_id}");
    let lifecycle_id = format!("lifecycle-{edge_id}");
    conn.execute(
        "INSERT INTO narrative_dependency_edge_states
            (edge_id, project_id, evidence_freshness, reason_code, build_action,
             evaluated_at_epoch_id, evaluated_at)
         VALUES (?1, ?2, 'source-missing', 'source-missing', 'rebuild-required', ?3, ?4)",
        params![edge_id, spec.project_id, epoch_id, SEEDED_AT],
    )?;
    conn.execute(
        "INSERT INTO narrative_consumer_freshness
            (project_id, consumer_kind, consumer_key, evidence_freshness,
             build_action, semantic_epoch_id, last_evaluated_run_id,
             dependency_set_digest, updated_at)
         VALUES (?1, ?2, ?3, 'source-missing', 'rebuild-required', ?4, ?3, 'old-set', ?5)",
        params![
            spec.project_id,
            consumer_kind,
            consumer_key,
            epoch_id,
            SEEDED_AT
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_maintenance_finding_observations
            (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
             reason_code, evidence_freshness_snapshot, material_basis_digest,
             observed_at, finding_identity, rule_id, rule_version, observation_digest)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'source-missing', 'source-missing',
                 ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            observation_id,
            spec.project_id,
            spec.run_id,
            epoch_id,
            edge_id,
            finding_key,
            material_basis_digest,
            SEEDED_AT,
            finding_identity,
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            observation_digest
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_maintenance_finding_lifecycle
            (id, project_id, finding_identity, finding_key, rule_id, rule_version,
             lifecycle_state, observation_digest, material_basis_digest, run_id,
             semantic_epoch_id, observed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'recurring',
                 ?7, ?8, ?9, ?10, ?11)",
        params![
            lifecycle_id,
            spec.project_id,
            finding_identity,
            finding_key,
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            observation_digest,
            material_basis_digest,
            spec.run_id,
            epoch_id,
            SEEDED_AT
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_maintenance_attention
            (project_id, finding_key, finding_identity, identity_resolution_status,
             disposition, material_basis_digest, snoozed_until, set_at, actor_id,
             request_id, payload_digest, reason, version)
         VALUES (?1, ?2, ?3, 'resolved', 'dismissed', ?4,
                 NULL, ?5, 'human-author', 'human-request', 'human-payload',
                 'human-reason', 7)",
        params![
            spec.project_id,
            finding_key,
            finding_identity,
            material_basis_digest,
            SEEDED_AT
        ],
    )?;
    Ok(())
}

fn canonical_finding_values(edge_id: &str) -> anyhow::Result<(String, String, String)> {
    let finding_identity = stable_finding_identity(
        BUNDLED_FINDING_RULE_ID,
        BUNDLED_FINDING_RULE_VERSION,
        edge_id,
    )?;
    let observation_digest = observation_digest(
        BUNDLED_FINDING_RULE_ID,
        BUNDLED_FINDING_RULE_VERSION,
        &ObservationDigestInput {
            stable_subject: edge_id,
            edge_id: Some(edge_id),
            failure_code: None,
            reason_code: FINDING_REASON_CODE,
            evidence_freshness: FINDING_EVIDENCE_FRESHNESS,
        },
    )?;
    let material_basis_digest = material_basis_digest(
        BUNDLED_FINDING_RULE_ID,
        BUNDLED_FINDING_RULE_VERSION,
        &MaterialBasisInput {
            stable_subject: edge_id,
            edge_id: Some(edge_id),
            failure_code: None,
            reason_code: FINDING_REASON_CODE,
            evidence_freshness: FINDING_EVIDENCE_FRESHNESS,
        },
    )?;
    Ok((finding_identity, observation_digest, material_basis_digest))
}

#[allow(clippy::type_complexity)]
fn application_edge_rows(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<(String, String, String, String, Option<String>)>> {
    let mut statement = conn.prepare(
        "SELECT id, consumer_key, source_object_identity, read_set_json, owning_run_id
           FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = 'application'
          ORDER BY consumer_key, source_object_identity, id",
    )?;
    let rows = statement
        .query_map([project_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn assert_no_rekey_marker_or_epoch(conn: &Connection, project_id: &str) -> anyhow::Result<()> {
    let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    assert_eq!(
        version, PREVIOUS_SCHEMA,
        "refused migration must keep schema 31"
    );
    let marker_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
        [APPLICATION_REKEY_MARKER],
        |row| row.get(0),
    )?;
    let epoch_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE project_id = ?1",
        [project_id],
        |row| row.get(0),
    )?;
    assert_eq!(
        marker_count, 0,
        "refused migration must not leave its marker"
    );
    assert_eq!(epoch_count, 1, "refused migration must not mint an epoch");
    Ok(())
}

#[test]
fn c2zb_rekeys_edges_rehomes_findings_invalidates_derived_state_and_is_idempotent() {
    let db = current_db_rewound_to_schema_31();
    db.with_conn(|conn| seed_project(conn, EXACT, true))
        .expect("seed exact C2-ZB fixture");

    db.migrate().expect("SCHEMA 31 -> 32 application re-key");
    let (expected_finding_identity, expected_observation_digest, expected_material_basis_digest) =
        canonical_finding_values(EXACT.edge_id).expect("compute canonical Finding values");
    db.with_conn(|conn| {
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, TARGET_SCHEMA);
        let marker_version: i64 = conn.query_row(
            "SELECT contract_version FROM schema_data_migrations
              WHERE migration_id = ?1",
            [APPLICATION_REKEY_MARKER],
            |row| row.get(0),
        )?;
        assert_eq!(marker_version, 1);

        assert_eq!(
            application_edge_rows(conn, EXACT.project_id)?,
            vec![(
                EXACT.edge_id.to_string(),
                EXACT.application_id.to_string(),
                EXACT.source_identity.to_string(),
                format!("[\"{}\"]", EXACT.revision_token),
                Some(EXACT.run_id.to_string()),
            )]
        );
        let edge_metadata: (Option<String>, String) = conn.query_row(
            "SELECT generated_by_transaction_id, created_at
               FROM narrative_dependency_edges WHERE id = ?1",
            [EXACT.edge_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(edge_metadata.0.as_deref(), Some("c2zb-generated"));
        assert_eq!(edge_metadata.1, SEEDED_AT);
        let old_edges: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
            params![EXACT.project_id, RUN_CONSUMER_KIND, EXACT.run_id],
            |row| row.get(0),
        )?;
        assert_eq!(old_edges, 0, "the legacy Run Consumer must be removed");

        let old_edge_state_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edge_states WHERE edge_id = ?1",
            [EXACT.edge_id],
            |row| row.get(0),
        )?;
        let derived_rows: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind IN (?2, ?3)",
            params![
                EXACT.project_id,
                RUN_CONSUMER_KIND,
                APPLICATION_CONSUMER_KIND
            ],
            |row| row.get(0),
        )?;
        assert_eq!(
            old_edge_state_count, 0,
            "moved Edge State must be invalidated"
        );
        assert_eq!(
            derived_rows, 0,
            "old and new Consumer Freshness must be invalidated"
        );

        let (
            finding_key,
            finding_identity,
            material_basis,
            observation_digest,
            observation_run_id,
            observation_epoch_id,
            observation_observed_at,
            observation_rule_id,
            observation_rule_version,
        ): (
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            i64,
        ) = conn.query_row(
            "SELECT finding_key, finding_identity, material_basis_digest, observation_digest,
                    run_id, semantic_epoch_id, observed_at, rule_id, rule_version
               FROM narrative_maintenance_finding_observations
              WHERE id = ?1",
            [format!("observation-{}", EXACT.edge_id)],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )?;
        assert_eq!(finding_key, format!("application:{}", EXACT.application_id));
        assert_eq!(finding_identity, expected_finding_identity);
        assert_eq!(material_basis, expected_material_basis_digest);
        assert_eq!(observation_digest, expected_observation_digest);
        assert_eq!(observation_run_id, EXACT.run_id);
        assert_eq!(
            observation_epoch_id,
            format!("{}-epoch-0", EXACT.project_id)
        );
        assert_eq!(observation_observed_at, SEEDED_AT);
        assert_eq!(observation_rule_id, BUNDLED_FINDING_RULE_ID);
        assert_eq!(
            observation_rule_version,
            i64::from(BUNDLED_FINDING_RULE_VERSION)
        );

        let lifecycle: (String, String, String, i64, String, String) = conn.query_row(
            "SELECT finding_key, finding_identity, rule_id, rule_version,
                    observation_digest, material_basis_digest
               FROM narrative_maintenance_finding_lifecycle WHERE id = ?1",
            [format!("lifecycle-{}", EXACT.edge_id)],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )?;
        assert_eq!(lifecycle.0, format!("application:{}", EXACT.application_id));
        assert_eq!(lifecycle.1, expected_finding_identity);
        assert_eq!(lifecycle.2, BUNDLED_FINDING_RULE_ID);
        assert_eq!(lifecycle.3, i64::from(BUNDLED_FINDING_RULE_VERSION));
        assert_eq!(lifecycle.4, expected_observation_digest);
        assert_eq!(lifecycle.5, expected_material_basis_digest);

        #[allow(clippy::type_complexity)]
        let attention: (
            String,
            String,
            String,
            String,
            String,
            Option<String>,
            String,
            String,
            String,
            String,
            String,
            i64,
        ) = conn.query_row(
            "SELECT finding_key, finding_identity, material_basis_digest,
                    identity_resolution_status, disposition, snoozed_until, set_at,
                    actor_id, request_id, payload_digest, reason, version
               FROM narrative_maintenance_attention WHERE project_id = ?1",
            [EXACT.project_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                ))
            },
        )?;
        assert_eq!(attention.0, format!("application:{}", EXACT.application_id));
        assert_eq!(attention.1, expected_finding_identity);
        assert_eq!(attention.2, expected_material_basis_digest);
        assert_eq!(attention.3, "resolved");
        assert_eq!(attention.4, "dismissed");
        assert_eq!(attention.5, None);
        assert_eq!(attention.6, SEEDED_AT);
        assert_eq!(attention.7, "human-author");
        assert_eq!(attention.8, "human-request");
        assert_eq!(attention.9, "human-payload");
        assert_eq!(attention.10, "human-reason");
        assert_eq!(attention.11, 7);

        let migration_epochs: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_semantic_epochs
              WHERE project_id = ?1 AND reason = 'migration'",
            [EXACT.project_id],
            |row| row.get(0),
        )?;
        assert_eq!(
            migration_epochs, 1,
            "the touched project gets one migration epoch"
        );
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify C2-ZB exact migration");

    let changes_before_retry = db
        .with_conn(|conn| Ok::<_, anyhow::Error>(conn.total_changes()))
        .expect("read total changes before retry");
    db.migrate().expect("second migrate is a no-op");
    db.with_conn(|conn| {
        assert_eq!(conn.total_changes(), changes_before_retry);
        let epoch_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE project_id = ?1",
            [EXACT.project_id],
            |row| row.get(0),
        )?;
        assert_eq!(
            epoch_count, 2,
            "idempotent retry must not mint another Epoch"
        );
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify C2-ZB idempotency");
}

#[test]
fn c2zb_fanout_without_finding_history_creates_all_application_edges() {
    let db = current_db_rewound_to_schema_31();
    db.with_conn(|conn| {
        seed_project(conn, EXACT, false)?;
        conn.execute(
            "INSERT INTO narrative_proposal_applications
                (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                 applied_entity_id, created_at)
             VALUES ('c2zb-application-fanout', ?1, 'proposal-fanout', 'revision-fanout',
                     'codex_entry', 'entry-fanout', ?2)",
            params![EXACT.commit_id, SEEDED_AT],
        )?;
        conn.execute(
            "INSERT INTO narrative_projection_dependencies
                (application_id, source_kind, source_key, observed_revision_token, propagation)
             VALUES ('c2zb-application-fanout', 'scene-body', ?1, 'c2zb-token-fanout',
                     'freshness-only')",
            [EXACT.source_identity],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed fan-out without Finding history");

    db.migrate().expect("deterministic C2-ZB fan-out");
    db.with_conn(|conn| {
        let rows = application_edge_rows(conn, EXACT.project_id)?;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].1, EXACT.application_id);
        assert_eq!(rows[1].1, "c2zb-application-fanout");
        assert_eq!(rows[0].3, format!("[\"{}\"]", EXACT.revision_token));
        assert_eq!(rows[1].3, "[\"c2zb-token-fanout\"]");
        assert!(rows.iter().all(|row| row.2 == EXACT.source_identity));
        assert!(rows
            .iter()
            .all(|row| row.4.as_deref() == Some(EXACT.run_id)));
        let old_run_edges: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
            params![EXACT.project_id, RUN_CONSUMER_KIND, EXACT.run_id],
            |row| row.get(0),
        )?;
        assert_eq!(old_run_edges, 0, "fan-out must remove the legacy Run edge");
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify C2-ZB fan-out");
}

#[test]
fn c2zb_rejects_invalid_unattributed_foreign_owner_and_historical_collision_atomically() {
    let cases = [
        "unattributed",
        "foreign-owner",
        "historical-collision",
        "ambiguous-fanout",
    ];
    for case in cases {
        let db = current_db_rewound_to_schema_31();
        db.with_conn(|conn| {
            seed_project(conn, EXACT, case == "ambiguous-fanout")?;
            match case {
                "unattributed" => {
                    conn.execute(
                        "DELETE FROM narrative_projection_dependencies WHERE application_id = ?1",
                        [EXACT.application_id],
                    )?;
                }
                "foreign-owner" => {
                    conn.execute(
                        "INSERT INTO projects (id, title) VALUES ('c2zb-project-foreign', 'Foreign')",
                        [],
                    )?;
                    conn.execute(
                        "INSERT INTO narrative_extraction_runs
                            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                             status, coverage_json, created_at, version, run_kind)
                         VALUES ('c2zb-run-foreign', 'c2zb-project-foreign', 'maintenance',
                                 '{}', '{}', 'foreign', 'completed', '{}', ?1, 0, 'backfill')",
                        [SEEDED_AT],
                    )?;
                    conn.execute(
                        "UPDATE narrative_dependency_edges SET owning_run_id = 'c2zb-run-foreign'
                          WHERE id = ?1",
                        [EXACT.edge_id],
                    )?;
                }
                "historical-collision" => {
                    conn.execute(
                        "INSERT INTO narrative_dependency_edges
                            (id, project_id, consumer_kind, consumer_key, source_object_identity,
                             read_set_json, created_at, owning_run_id)
                         VALUES ('c2zb-edge-existing', ?1, 'application', ?2, ?3,
                                 '[\"different-token\"]', ?4, ?5)",
                        params![
                            EXACT.project_id,
                            EXACT.application_id,
                            EXACT.source_identity,
                            SEEDED_AT,
                            EXACT.run_id
                        ],
                    )?;
                    let epoch_id = format!("{}-epoch-0", EXACT.project_id);
                    let existing = ProjectSpec {
                        edge_id: "c2zb-edge-existing",
                        ..EXACT
                    };
                    seed_finding_history(
                        conn,
                        existing,
                        &epoch_id,
                        existing.edge_id,
                        APPLICATION_CONSUMER_KIND,
                        EXACT.application_id,
                    )?;
                }
                "ambiguous-fanout" => {
                    conn.execute(
                        "INSERT INTO narrative_proposal_applications
                            (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                             applied_entity_id, created_at)
                         VALUES ('c2zb-application-fanout', ?1, 'proposal-fanout', 'revision-fanout',
                                 'codex_entry', 'entry-fanout', ?2)",
                        params![EXACT.commit_id, SEEDED_AT],
                    )?;
                    conn.execute(
                        "INSERT INTO narrative_projection_dependencies
                            (application_id, source_kind, source_key, observed_revision_token,
                             propagation)
                         VALUES ('c2zb-application-fanout', 'scene-body', ?1,
                                 'c2zb-token-fanout', 'freshness-only')",
                        [EXACT.source_identity],
                    )?;
                }
                _ => unreachable!("known C2-ZB refusal case"),
            }
            Ok::<_, anyhow::Error>(())
        })
        .unwrap_or_else(|error| panic!("seed {case} fixture: {error:#}"));

        let application_edges_before = db
            .with_conn(|conn| application_edge_rows(conn, EXACT.project_id))
            .unwrap_or_else(|error| panic!("snapshot {case} Application edges: {error:#}"));
        db.migrate()
            .expect_err("invalid C2-ZB provenance must refuse atomically");
        db.with_conn(|conn| {
            assert_no_rekey_marker_or_epoch(conn, EXACT.project_id)?;
            let old_edge_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edges
                  WHERE id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
                params![EXACT.edge_id, RUN_CONSUMER_KIND, EXACT.run_id],
                |row| row.get(0),
            )?;
            assert_eq!(old_edge_count, 1, "refusal must retain the legacy edge");
            assert_eq!(
                application_edge_rows(conn, EXACT.project_id)?,
                application_edges_before,
                "refusal must preserve pre-existing Application edges byte-for-byte"
            );
            Ok::<_, anyhow::Error>(())
        })
        .unwrap_or_else(|error| panic!("verify atomic refusal for {case}: {error:#}"));
    }
}

#[test]
fn c2zb_marker_failpoint_rolls_back_and_retry_is_safe() {
    let db = current_db_rewound_to_schema_31();
    db.with_conn(|conn| {
        seed_project(conn, EXACT, true)?;
        conn.execute_batch(
            "CREATE TRIGGER c2zb_application_rekey_failpoint
               BEFORE INSERT ON schema_data_migrations
               WHEN NEW.migration_id = 'narrative-c2-application-rekey-v32'
               BEGIN
                 SELECT RAISE(ABORT, 'simulated C2-ZB marker failpoint');
               END;",
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("arm C2-ZB marker failpoint");

    db.migrate()
        .expect_err("marker failpoint must abort the migration");
    db.with_conn(|conn| {
        assert_no_rekey_marker_or_epoch(conn, EXACT.project_id)?;
        assert_eq!(application_edge_rows(conn, EXACT.project_id)?.len(), 0);
        let old_edge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
            params![EXACT.edge_id, RUN_CONSUMER_KIND, EXACT.run_id],
            |row| row.get(0),
        )?;
        assert_eq!(old_edge_count, 1);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify C2-ZB marker rollback");

    db.with_conn(|conn| {
        conn.execute_batch("DROP TRIGGER c2zb_application_rekey_failpoint;")?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("disarm C2-ZB marker failpoint");
    db.migrate().expect("retry after marker failpoint");
    db.with_conn(|conn| {
        assert_eq!(application_edge_rows(conn, EXACT.project_id)?.len(), 1);
        let marker_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
            [APPLICATION_REKEY_MARKER],
            |row| row.get(0),
        )?;
        assert_eq!(marker_count, 1);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify C2-ZB retry");
}

#[test]
fn legacy_backfill_v3_emits_application_edges_bound_to_the_owning_run() {
    let db = current_db_rewound_to_schema_31();
    db.with_conn(|conn| seed_project(conn, EXACT, false))
        .expect("seed legacy Application for the future Backfill writer");

    let outcome = bootstrap_legacy_dependency_backfill_for_project(&db, EXACT.project_id)
        .expect("run legacy Backfill writer");
    let backfill_run_id = match outcome {
        LegacyBackfillBootstrapOutcome::Ran { run_id, .. } => run_id,
        LegacyBackfillBootstrapOutcome::AlreadyRun { .. } => {
            panic!("fresh fixture must run the Backfill writer")
        }
    };
    db.with_conn(|conn| {
        let work_key: Option<String> = conn.query_row(
            "SELECT work_key FROM narrative_extraction_runs WHERE id = ?1",
            [backfill_run_id.as_str()],
            |row| row.get(0),
        )?;
        assert_eq!(work_key.as_deref(), Some(BACKFILL_V3_WORK_KEY));

        let edge: (String, String, Option<String>) = conn.query_row(
            "SELECT consumer_kind, consumer_key, owning_run_id
               FROM narrative_dependency_edges
              WHERE project_id = ?1 AND source_object_identity = ?2
                AND owning_run_id = ?3",
            params![
                EXACT.project_id,
                EXACT.source_identity,
                backfill_run_id.as_str()
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(edge.0, APPLICATION_CONSUMER_KIND);
        assert_eq!(edge.1, EXACT.application_id);
        assert_eq!(edge.2.as_deref(), Some(backfill_run_id.as_str()));
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify future Backfill writer contract");
}
