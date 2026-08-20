//! A workspace in the physical shape a SCHEMA 23-28 build actually left on
//! disk, so `migrate()` can be exercised over the whole Gate C2 upgrade path
//! rather than over a scratch database holding only the tables one migration
//! happens to read.
//!
//! The distinction matters because the base DDL is not neutral on an upgrade.
//! It runs as `CREATE TABLE IF NOT EXISTS` against whatever shape the
//! workspace already has, so on a fresh database it creates the current
//! columns and on an upgrade it is a no-op — which is exactly how
//! `idx_narrative_application_contributions_commit` could sit in that batch,
//! pass every fresh-database test, and stop a real SCHEMA 23-28 workspace from
//! ever opening again. Reproducing the era's physical shape is the only way a
//! test can tell those two situations apart.
//!
//! The fixture is built by materialising the current schema and then rewinding
//! the objects each post-23 migration changes, which keeps it honest in one
//! specific way: the "rewind" is written from the same DDL the migration reads
//! back, so a future schema revision that forgets this file fails loudly
//! (the rewind stops matching) instead of silently degrading into a fresh
//! database wearing an old `user_version`.

#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use grimodex_db::Database;
use rusqlite::{params, Connection};

/// The oldest and newest markers a Gate C2 workspace can carry on disk today.
/// SCHEMA 23 is the first Semantic Build Graph schema; 30 is the last one
/// before the current Finding identity marker.
pub const OLDEST_C2_ERA: i32 = 23;
pub const NEWEST_C2_ERA: i32 = 30;
/// The newest marker that still needs the SCHEMA 29 Contribution rebuild.
/// Tests about that rebuild bound themselves with this rather than with
/// [`NEWEST_C2_ERA`], which has already been through it.
pub const NEWEST_PRE_V29_ERA: i32 = 28;

pub const PROJECT_ID: &str = "c2-upgrade-project";
pub const SCENE_ID: &str = "c2-upgrade-scene";
pub const ENTRY_ID: &str = "c2-upgrade-entry";
pub const CHRONICLE_EVENT_ID: &str = "c2-upgrade-event";

pub const COMMIT_ID: &str = "c2-upgrade-commit";
pub const APPLICATION_ID: &str = "c2-upgrade-application";
pub const PROPOSAL_ID: &str = "c2-upgrade-proposal";
pub const REVISION_ID: &str = "c2-upgrade-revision";

/// The Consumer whose Dependency Edge the SCHEMA 28 repair rewrites, and the
/// one it leaves alone. Two are needed because the repair invalidates derived
/// state only for the Consumers it touched, while the SCHEMA 28 completion
/// marker discards *all* of it — so only an untouched Consumer can tell the
/// two apart, and only it can witness the Gate C2 savepoint unwinding.
pub const REPAIRED_RUN_ID: &str = "c2-upgrade-run-repaired";
pub const UNTOUCHED_RUN_ID: &str = "c2-upgrade-run-untouched";
pub const RUN_CONSUMER_KIND: &str = "narrative-extraction-run";

pub const REPAIRED_EDGE_ID: &str = "c2-upgrade-edge-doubled";
pub const UNTOUCHED_EDGE_ID: &str = "c2-upgrade-edge-canonical";
pub const CANONICAL_EDGE_IDENTITY: &str = "project:scene:c2-upgrade-scene";
pub const UNTOUCHED_EDGE_IDENTITY: &str = "project:codex-catalog:c2-upgrade-project";

/// A third Consumer, and the only one SCHEMA 30's re-key can act on: it owns
/// a Proposal Revision whose durable Source Basis names the Source its Edge
/// reads. The other two have no Revision to attribute a read to, so they stay
/// Run-grained -- which is what makes this one able to witness the re-key
/// happening, and the safety tests able to witness it *not* happening.
pub const REKEYED_RUN_ID: &str = "c2-upgrade-run-rekeyed";
pub const REKEYED_EDGE_ID: &str = "c2-upgrade-edge-rekeyed";
pub const REKEYED_PROPOSAL_SET_ID: &str = "c2-upgrade-set-rekeyed";
pub const REKEYED_PROPOSAL_ID: &str = "c2-upgrade-proposal-rekeyed";
pub const REKEYED_REVISION_ID: &str = "c2-upgrade-revision-rekeyed";
pub const REKEYED_EDGE_IDENTITY: &str = "project:scene:c2-upgrade-scene-rekeyed";
pub const REKEYED_REVISION_TOKEN: &str = "c2-upgrade-token-rekeyed";
pub const REVISION_CONSUMER_KIND: &str = "proposal-revision";

/// A field the Field Authority ledger already records as the author's, so the
/// SCHEMA 29 ownership re-projection has something to move, and one nobody
/// claimed, so a blanket stamp would be as visible as no re-projection at all.
pub const HUMAN_OWNED_CONTRIBUTION_ID: &str = "c2-upgrade-contribution-name";
pub const MAINTAINED_CONTRIBUTION_ID: &str = "c2-upgrade-contribution-summary";
/// A Contribution the Apply path filed under the Field Authority vocabulary
/// (`event:`), which is canonical in neither writer's spelling.
pub const CHRONICLE_CONTRIBUTION_ID: &str = "c2-upgrade-contribution-event";

pub const CANONICAL_CODEX_IDENTITY: &str = "codex-entry:c2-upgrade-entry";
pub const CANONICAL_CHRONICLE_IDENTITY: &str = "chronicle-event:c2-upgrade-event";
pub const HUMAN_OWNED_FIELD_PATH: &str = "/name";
pub const MAINTAINED_FIELD_PATH: &str = "/summary";
pub const CHRONICLE_FIELD_PATH: &str = "/title";

/// The `change_events.sequence` of this Application's own canonical apply
/// event, which is the baseline SCHEMA 29 must reconstruct.
pub const APPLY_EVENT_SEQUENCE: i64 = 42;
/// A later apply event belonging to a different commit, so a reconstruction
/// that took the project's *maximum* apply sequence would be visibly wrong.
pub const LATER_OTHER_APPLY_EVENT_SEQUENCE: i64 = 55;
/// An *earlier* apply event belonging to a third commit. Without it the
/// project-wide minimum apply sequence is also 42, and dropping `entity_id`
/// from SCHEMA 29's grouping -- taking the project's first apply instead of
/// this commit's -- would leave every assertion in this fixture green.
pub const EARLIER_OTHER_APPLY_EVENT_SEQUENCE: i64 = 11;

pub const ATTENTION_FINDING_KEY: &str = "narrative-extraction-run:c2-upgrade-run-repaired";
pub const ATTENTION_ACTOR_ID: &str = "c2-upgrade-actor";
pub const UNATTRIBUTED_ATTENTION_FINDING_KEY: &str = "narrative-extraction-run:c2-upgrade-unknown";
/// The sentinel SCHEMA 25 gives a disposition whose `set_by` was NULL.
pub const LEGACY_ACTOR_SENTINEL: &str = "unknown-legacy-actor";

const SEEDED_AT: &str = "2026-08-15T00:00:00.000Z";

/// A workspace directory holding one SCHEMA 23-28 shaped database.
pub struct EraWorkspace {
    pub root: PathBuf,
    pub db_path: PathBuf,
    pub era: i32,
}

impl EraWorkspace {
    /// Opens the seeded database on the live path, the way the desktop does.
    pub fn open(&self) -> Database {
        Database::new(&self.db_path).expect("open the seeded era workspace")
    }

    /// `narrative_maintenance_repair_leases` and
    /// `narrative_semantic_index_metadata` arrived at SCHEMA 24, so a
    /// SCHEMA 23 workspace has no lease row to preserve — the migration
    /// creates the tables empty instead.
    pub fn has_v24_tables(&self) -> bool {
        self.era >= 24
    }

    /// Whether this era still carries the pre-#535 identities the SCHEMA 28
    /// repair rewrites. A workspace stamped 28 was written *by* that build, so
    /// its rows are already canonical and it carries the completion marker.
    pub fn needs_identity_repair(&self) -> bool {
        self.era < 28
    }
}

pub fn temp_workspace(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "grimodex-c2-upgrade-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).expect("create temporary workspace");
    root
}

/// Seeds a workspace whose physical shape, rows and `user_version` are those a
/// build of `era` left behind.
pub fn seed_c2_era_workspace(label: &str, era: i32) -> EraWorkspace {
    assert!(
        (OLDEST_C2_ERA..=NEWEST_C2_ERA).contains(&era),
        "era {era} is outside the Gate C2 upgrade path"
    );
    let root = temp_workspace(&format!("{label}-v{era}"));
    let db_path = root.join("grimodex.db");
    {
        let db = Database::new(&db_path).expect("create the workspace database");
        db.migrate().expect("materialise the current base DDL");
        db.with_conn(|conn| {
            // The rewind drops and renames tables other objects reference by
            // name, which is what the production rebuilds disable foreign keys
            // for. Every table is still empty here, so nothing is copied and
            // no constraint is deferred across rows.
            let foreign_keys: bool = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
            conn.pragma_update(None, "foreign_keys", false)?;
            let rewind = rewind_schema_to_era(conn, era);
            conn.pragma_update(None, "foreign_keys", foreign_keys)?;
            rewind?;
            seed_era_rows(conn, era)?;
            if era < 28 {
                // SCHEMA 28's completion marker was written by the same build
                // that performed the identity repair, so an older workspace
                // cannot have it.
                conn.execute(
                    "DELETE FROM schema_data_migrations WHERE migration_id = 'narrative-c2-identity-v28'",
                    [],
                )?;
            }
            // Likewise SCHEMA 30's, for every era on this path: the fixture is
            // built by migrating to the current schema and rewinding, so it
            // inherits a marker no real SCHEMA 23-30 workspace can carry --
            // and the marker is precisely what makes the re-key a no-op, so
            // leaving it would make every assertion about the re-key pass
            // against a migration that never ran.
            conn.execute(
                "DELETE FROM schema_data_migrations
                  WHERE migration_id = 'narrative-c2-consumer-grain-v30'",
                [],
            )?;
            conn.execute(
                "DELETE FROM schema_data_migrations
                  WHERE migration_id = 'narrative-c2-finding-identity-v31'",
                [],
            )?;
            conn.pragma_update(None, "user_version", era)?;
            Ok(())
        })
        .unwrap_or_else(|error| panic!("rewind the workspace to SCHEMA {era}: {error:#}"));
    }
    EraWorkspace { root, db_path, era }
}

fn rewind_schema_to_era(conn: &Connection, era: i32) -> anyhow::Result<()> {
    if era < 31 {
        rewind_finding_identity_to_v30(conn)?;
    }
    if era < 30 {
        rewind_dependency_edge_owning_run(conn)?;
    }
    if era < 29 {
        rewind_application_contributions_to_v28(conn)?;
    }
    if (24..27).contains(&era) {
        rewind_repair_lease_run_binding(conn)?;
    }
    if era < 26 {
        rewind_run_request_identity(conn)?;
    }
    if era < 25 {
        rewind_maintenance_attention(conn)?;
    }
    if era < 24 {
        rewind_v24_objects(conn)?;
    }
    Ok(())
}

/// SCHEMA 30 is the pre-C2-3 shape: Finding identity, observation digest, the
/// lifecycle table, and Attention's identity column do not exist yet. The
/// fixture starts from the current DDL and removes those objects so a v30
/// upgrade exercises the real additive migration rather than a fresh DB.
fn rewind_finding_identity_to_v30(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS narrative_maintenance_finding_lifecycle;
         ALTER TABLE narrative_maintenance_finding_observations
            DROP COLUMN observation_digest;
         ALTER TABLE narrative_maintenance_finding_observations
            DROP COLUMN rule_version;
         ALTER TABLE narrative_maintenance_finding_observations
            DROP COLUMN rule_id;
         ALTER TABLE narrative_maintenance_finding_observations
            DROP COLUMN finding_identity;
         ALTER TABLE narrative_maintenance_attention
            DROP COLUMN identity_resolution_status;
         ALTER TABLE narrative_maintenance_attention
            DROP COLUMN finding_identity;",
    )?;
    Ok(())
}

/// The pre-SCHEMA-30 shape of `narrative_dependency_edges`: no record of the
/// Run that declared each Edge, so resolving a `snapshot:<runId>` Source
/// still depended on `consumer_key` happening to be that Run's id.
///
/// `DROP COLUMN` rather than a rebuild: the column is nullable, carries no
/// constraint and is last in the table, which is exactly the shape SQLite can
/// drop in place.
fn rewind_dependency_edge_owning_run(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch("ALTER TABLE narrative_dependency_edges DROP COLUMN owning_run_id;")?;
    Ok(())
}

/// The SCHEMA 28 shape of `narrative_application_contributions`: no
/// provenance, no value baseline, no ownership axis — and therefore no
/// `commit_id` for the base DDL's index to name.
fn rewind_application_contributions_to_v28(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_narrative_application_contributions_commit;
         CREATE TABLE narrative_application_contributions_era (
            id                     TEXT NOT NULL,
            project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            application_id         TEXT NOT NULL CHECK(length(application_id) > 0),
            target_object_identity TEXT NOT NULL CHECK(length(target_object_identity) > 0),
            field_path             TEXT NOT NULL CHECK(length(field_path) > 0),
            target_state           TEXT NOT NULL
                CHECK(target_state IN ('unchanged','modified','missing','superseded','undone','not-applicable')),
            created_at             TEXT NOT NULL,
            PRIMARY KEY(id),
            UNIQUE(project_id, application_id, target_object_identity, field_path)
         );
         INSERT INTO narrative_application_contributions_era
            (id, project_id, application_id, target_object_identity, field_path,
             target_state, created_at)
         SELECT id, project_id, application_id, target_object_identity, field_path,
                target_state, created_at
           FROM narrative_application_contributions;
         DROP TABLE narrative_application_contributions;
         ALTER TABLE narrative_application_contributions_era
            RENAME TO narrative_application_contributions;
         CREATE INDEX IF NOT EXISTS idx_narrative_application_contributions_target
            ON narrative_application_contributions(project_id, target_object_identity);
         CREATE INDEX IF NOT EXISTS idx_narrative_application_contributions_field
            ON narrative_application_contributions(project_id, target_object_identity, field_path);
         CREATE INDEX IF NOT EXISTS idx_narrative_application_contributions_application
            ON narrative_application_contributions(project_id, application_id);",
    )?;
    Ok(())
}

fn rewind_repair_lease_run_binding(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "ALTER TABLE narrative_maintenance_repair_leases DROP COLUMN active_run_id;",
    )?;
    Ok(())
}

fn rewind_run_request_identity(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "DROP INDEX IF EXISTS uq_narrative_runs_request_identity;
         ALTER TABLE narrative_extraction_runs DROP COLUMN request_id;
         ALTER TABLE narrative_extraction_runs DROP COLUMN idempotency_domain;
         ALTER TABLE narrative_extraction_runs DROP COLUMN request_payload_digest;
         ALTER TABLE narrative_extraction_runs DROP COLUMN actor_id;",
    )?;
    Ok(())
}

/// The pre-SCHEMA-25 Attention table: a nullable `set_by` and none of the OCC
/// or request-identity columns.
fn rewind_maintenance_attention(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE narrative_maintenance_attention_era (
            project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            finding_key            TEXT NOT NULL CHECK(length(finding_key) > 0),
            disposition            TEXT NOT NULL CHECK(disposition IN ('snoozed','dismissed','flagged')),
            material_basis_digest  TEXT NOT NULL CHECK(length(material_basis_digest) > 0),
            snoozed_until          TEXT,
            set_at                 TEXT NOT NULL,
            set_by                 TEXT,
            PRIMARY KEY(project_id, finding_key)
         );
         INSERT INTO narrative_maintenance_attention_era
            (project_id, finding_key, disposition, material_basis_digest,
             snoozed_until, set_at, set_by)
         SELECT project_id, finding_key, disposition, material_basis_digest,
                snoozed_until, set_at, actor_id
           FROM narrative_maintenance_attention;
         DROP TABLE narrative_maintenance_attention;
         ALTER TABLE narrative_maintenance_attention_era
            RENAME TO narrative_maintenance_attention;",
    )?;
    Ok(())
}

/// Everything SCHEMA 24 introduced: the two Run Kind Policy tables, the Verify
/// baseline columns, and the widened `run_kind` vocabulary.
fn rewind_v24_objects(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS narrative_semantic_index_metadata;
         DROP TABLE IF EXISTS narrative_maintenance_repair_leases;
         ALTER TABLE narrative_dependency_edge_states
            DROP COLUMN observed_source_revision_token;
         ALTER TABLE narrative_dependency_edge_states DROP COLUMN observed_source_digest;
         ALTER TABLE narrative_consumer_freshness DROP COLUMN dependency_set_digest;
         CREATE TABLE narrative_extraction_runs_era (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            surface_path_id TEXT NOT NULL,
            scope_json TEXT NOT NULL,
            spec_json TEXT NOT NULL,
            spec_digest TEXT NOT NULL,
            snapshot_digest TEXT,
            catalog_digest TEXT,
            registry_digest TEXT,
            status TEXT NOT NULL
                CHECK(status IN ('pending','running','completed','failed','cancelled','superseded')),
            coverage_json TEXT NOT NULL DEFAULT '{}',
            outcome_summary_json TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            version INTEGER NOT NULL DEFAULT 0,
            run_kind TEXT NOT NULL DEFAULT 'interpretation'
                CHECK(run_kind IN ('interpretation','freshness-evaluation','semantic-index-rebuild','manual-rebuild','backfill')),
            consumer_id TEXT,
            semantic_epoch_id TEXT REFERENCES narrative_semantic_epochs(id),
            work_key TEXT,
            terminal_reason_code TEXT
                CHECK(terminal_reason_code IS NULL OR terminal_reason_code GLOB 'NEX_*'),
            superseded_by_run_id TEXT REFERENCES narrative_extraction_runs(id)
         );
         INSERT INTO narrative_extraction_runs_era
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             snapshot_digest, catalog_digest, registry_digest, status, coverage_json,
             outcome_summary_json, created_at, started_at, completed_at, version,
             run_kind, consumer_id, semantic_epoch_id, work_key, terminal_reason_code,
             superseded_by_run_id)
         SELECT id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                snapshot_digest, catalog_digest, registry_digest, status, coverage_json,
                outcome_summary_json, created_at, started_at, completed_at, version,
                run_kind, consumer_id, semantic_epoch_id, work_key, terminal_reason_code,
                superseded_by_run_id
           FROM narrative_extraction_runs;
         DROP TABLE narrative_extraction_runs;
         ALTER TABLE narrative_extraction_runs_era RENAME TO narrative_extraction_runs;",
    )?;
    Ok(())
}

fn seed_era_rows(conn: &Connection, era: i32) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO projects (id, title) VALUES (?1, 'C2 upgrade path')",
        params![PROJECT_ID],
    )?;
    conn.execute(
        "INSERT INTO narrative_semantic_epochs
            (id, project_id, epoch_number, reason, created_at)
         VALUES ('c2-upgrade-epoch', ?1, 0, 'initial', ?2)",
        params![PROJECT_ID, SEEDED_AT],
    )?;

    seed_runs(conn)?;
    seed_apply_history(conn)?;
    seed_change_events(conn)?;
    seed_field_authority(conn)?;
    seed_contributions(conn, era)?;
    seed_dependency_graph(conn, era)?;
    seed_rekeyable_consumer(conn)?;
    seed_attention(conn, era)?;
    if era >= 24 {
        seed_v24_rows(conn)?;
    }
    Ok(())
}

fn seed_runs(conn: &Connection) -> anyhow::Result<()> {
    for run_id in [REPAIRED_RUN_ID, UNTOUCHED_RUN_ID, REKEYED_RUN_ID] {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, version, run_kind)
             VALUES (?1, ?2, 'chronicle.extract', '{}', '{}', 'c2-upgrade-spec-digest',
                     'completed', '{}', ?3, 0, 'backfill')",
            params![run_id, PROJECT_ID, SEEDED_AT],
        )?;
    }
    Ok(())
}

fn seed_apply_history(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO narrative_apply_commits
            (id, project_id, run_id, request_id, plan_digest, status, created_at)
         VALUES (?1, ?2, ?3, 'c2-upgrade-request', 'c2-upgrade-plan-digest', 'committed', ?4)",
        params![COMMIT_ID, PROJECT_ID, REPAIRED_RUN_ID, SEEDED_AT],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_applications
            (id, commit_id, proposal_id, revision_id, applied_entity_kind,
             applied_entity_id, created_at)
         VALUES (?1, ?2, ?3, ?4, 'codex_entry', ?5, ?6)",
        params![
            APPLICATION_ID,
            COMMIT_ID,
            PROPOSAL_ID,
            REVISION_ID,
            ENTRY_ID,
            SEEDED_AT
        ],
    )?;
    Ok(())
}

/// The canonical audit log the SCHEMA 29 baseline is reconstructed from.
///
/// Three apply events, deliberately straddling this commit's own: the
/// project's minimum apply sequence is 11 and its maximum is 55, so the only
/// way to arrive at 42 is to group by `entity_id` the way SCHEMA 29's
/// subquery does. An unrelated non-apply edit sits at 7 to prove the
/// `op_type` filter is doing its job too.
fn seed_change_events(conn: &Connection) -> anyhow::Result<()> {
    for (op_type, entity_id, sequence) in [
        ("codex.entry.update", ENTRY_ID, 7_i64),
        (
            "narrative.commit.apply",
            "c2-upgrade-earlier-commit",
            EARLIER_OTHER_APPLY_EVENT_SEQUENCE,
        ),
        ("narrative.commit.apply", COMMIT_ID, APPLY_EVENT_SEQUENCE),
        (
            "narrative.commit.apply",
            "c2-upgrade-later-commit",
            LATER_OTHER_APPLY_EVENT_SEQUENCE,
        ),
    ] {
        conn.execute(
            "INSERT INTO change_events
                (project_id, domain, op_type, entity_type, entity_id, payload,
                 session_id, sequence, timestamp, prev_hash, hash)
             VALUES (?1, 'narrative', ?2, 'narrative', ?3, '{}', 'c2-upgrade-session',
                     ?4, ?4, '', 'c2-upgrade-hash-' || ?4)",
            params![PROJECT_ID, op_type, entity_id, sequence],
        )?;
    }
    Ok(())
}

fn seed_field_authority(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO narrative_field_authority
            (project_id, entity_kind, entity_id, field_path, owner_kind,
             explicit_lock, version, updated_at)
         VALUES (?1, 'codex-entry', ?2, ?3, 'human', 0, 1, ?4)",
        params![PROJECT_ID, ENTRY_ID, HUMAN_OWNED_FIELD_PATH, SEEDED_AT],
    )?;
    Ok(())
}

/// The three Contributions, spelled the way the era's writers spelled them.
/// A workspace stamped 28 was written by the build that performed the identity
/// repair, so its rows are already canonical; anything older still carries the
/// writer-row and Field Authority vocabularies side by side.
fn seed_contributions(conn: &Connection, era: i32) -> anyhow::Result<()> {
    let legacy = era < 28;
    let codex_identity = if legacy {
        "codex_entry:c2-upgrade-entry"
    } else {
        CANONICAL_CODEX_IDENTITY
    };
    let chronicle_identity = if legacy {
        "event:c2-upgrade-event"
    } else {
        CANONICAL_CHRONICLE_IDENTITY
    };
    for (id, identity, field_path) in [
        (
            HUMAN_OWNED_CONTRIBUTION_ID,
            codex_identity,
            HUMAN_OWNED_FIELD_PATH,
        ),
        (
            MAINTAINED_CONTRIBUTION_ID,
            CANONICAL_CODEX_IDENTITY,
            MAINTAINED_FIELD_PATH,
        ),
        (
            CHRONICLE_CONTRIBUTION_ID,
            chronicle_identity,
            CHRONICLE_FIELD_PATH,
        ),
    ] {
        if era >= 29 {
            // A SCHEMA 29 build already performed the rebuild, so its rows
            // carry the provenance the migration reconstructs and the
            // ownership it re-projected from the Field Authority ledger.
            // Seeding them any other way would make an already-migrated
            // workspace look like one that still needs migrating, and the
            // idempotency assertions would pass for the wrong reason.
            let ownership = if id == HUMAN_OWNED_CONTRIBUTION_ID {
                "user-owned"
            } else {
                "maintained"
            };
            conn.execute(
                "INSERT INTO narrative_application_contributions
                    (id, project_id, application_id, commit_id, proposal_id, revision_id,
                     operation_id, target_object_identity, field_path, target_state,
                     maintenance_ownership, baseline_sequence, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, 'unchanged', ?9, ?10, ?11)",
                params![
                    id,
                    PROJECT_ID,
                    APPLICATION_ID,
                    COMMIT_ID,
                    PROPOSAL_ID,
                    REVISION_ID,
                    identity,
                    field_path,
                    ownership,
                    APPLY_EVENT_SEQUENCE,
                    SEEDED_AT
                ],
            )?;
            continue;
        }
        conn.execute(
            "INSERT INTO narrative_application_contributions
                (id, project_id, application_id, target_object_identity, field_path,
                 target_state, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'unchanged', ?6)",
            params![
                id,
                PROJECT_ID,
                APPLICATION_ID,
                identity,
                field_path,
                SEEDED_AT
            ],
        )?;
    }
    Ok(())
}

fn seed_dependency_graph(conn: &Connection, era: i32) -> anyhow::Result<()> {
    let repaired_identity = if era < 28 {
        "project:scene:project:scene:c2-upgrade-scene"
    } else {
        CANONICAL_EDGE_IDENTITY
    };
    for (edge_id, run_id, identity) in [
        (REPAIRED_EDGE_ID, REPAIRED_RUN_ID, repaired_identity),
        (UNTOUCHED_EDGE_ID, UNTOUCHED_RUN_ID, UNTOUCHED_EDGE_IDENTITY),
    ] {
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key, source_object_identity,
                 read_set_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, '[]', ?6)",
            params![
                edge_id,
                PROJECT_ID,
                RUN_CONSUMER_KIND,
                run_id,
                identity,
                SEEDED_AT
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_dependency_edge_states
                (edge_id, project_id, evidence_freshness, reason_code, build_action,
                 evaluated_at_epoch_id, evaluated_at)
             VALUES (?1, ?2, 'source-missing', 'source-missing', 'rebuild-required',
                     'c2-upgrade-epoch', ?3)",
            params![edge_id, PROJECT_ID, SEEDED_AT],
        )?;
        conn.execute(
            "INSERT INTO narrative_consumer_freshness
                (project_id, consumer_kind, consumer_key, evidence_freshness,
                 build_action, semantic_epoch_id, last_evaluated_run_id, updated_at)
             VALUES (?1, ?2, ?3, 'source-missing', 'rebuild-required',
                     'c2-upgrade-epoch', ?3, ?4)",
            params![PROJECT_ID, RUN_CONSUMER_KIND, run_id, SEEDED_AT],
        )?;
        conn.execute(
            "INSERT INTO narrative_maintenance_finding_observations
                (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
                 reason_code, evidence_freshness_snapshot, material_basis_digest,
                 observed_at)
             VALUES ('observation-' || ?1, ?2, ?3, 'c2-upgrade-epoch', ?1,
                     ?4 || ':' || ?3, 'source-missing', 'source-missing',
                     'c2-upgrade-basis-digest', ?5)",
            params![edge_id, PROJECT_ID, run_id, RUN_CONSUMER_KIND, SEEDED_AT],
        )?;
    }
    Ok(())
}

/// The Proposal chain and durable Source Basis SCHEMA 30's re-key reads its
/// finer attribution out of, plus the one Edge it can therefore move.
///
/// Seeded for every era: `narrative_revision_source_basis` predates Gate C2
/// entirely, so a SCHEMA 23 workspace can already hold this and a real one
/// does. Without it the re-key is a no-op on this fixture, and every
/// assertion about the re-key -- including the two that assert it was
/// *unwound* -- would pass on a workspace where it never ran.
fn seed_rekeyable_consumer(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO narrative_proposal_sets
            (id, run_id, project_id, set_kind, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'extraction', ?4, ?4)",
        params![
            REKEYED_PROPOSAL_SET_ID,
            REKEYED_RUN_ID,
            PROJECT_ID,
            SEEDED_AT
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposals
            (id, proposal_set_id, proposal_key, kind, payload_json, created_at, updated_at)
         VALUES (?1, ?2, 'c2-upgrade-key-rekeyed', 'codex-entry', '{}', ?3, ?3)",
        params![REKEYED_PROPOSAL_ID, REKEYED_PROPOSAL_SET_ID, SEEDED_AT],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_revisions
            (id, proposal_id, revision_number, payload_json, created_at, created_by)
         VALUES (?1, ?2, 1, '{}', ?3, 'c2-upgrade-actor')",
        params![REKEYED_REVISION_ID, REKEYED_PROPOSAL_ID, SEEDED_AT],
    )?;
    conn.execute(
        "INSERT INTO narrative_revision_source_basis
            (revision_id, ordinal, source_kind, source_key, revision_token)
         VALUES (?1, 0, 'scene-body', ?2, ?3)",
        params![
            REKEYED_REVISION_ID,
            REKEYED_EDGE_IDENTITY,
            REKEYED_REVISION_TOKEN
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_dependency_edges
            (id, project_id, consumer_kind, consumer_key, source_object_identity,
             read_set_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            REKEYED_EDGE_ID,
            PROJECT_ID,
            RUN_CONSUMER_KIND,
            REKEYED_RUN_ID,
            REKEYED_EDGE_IDENTITY,
            format!("[\"{REKEYED_REVISION_TOKEN}\"]"),
            SEEDED_AT
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_dependency_edge_states
            (edge_id, project_id, evidence_freshness, reason_code, build_action,
             evaluated_at_epoch_id, evaluated_at)
         VALUES (?1, ?2, 'source-missing', 'source-missing', 'rebuild-required',
                 'c2-upgrade-epoch', ?3)",
        params![REKEYED_EDGE_ID, PROJECT_ID, SEEDED_AT],
    )?;
    conn.execute(
        "INSERT INTO narrative_consumer_freshness
            (project_id, consumer_kind, consumer_key, evidence_freshness,
             build_action, semantic_epoch_id, last_evaluated_run_id, updated_at)
         VALUES (?1, ?2, ?3, 'source-missing', 'rebuild-required',
                 'c2-upgrade-epoch', ?3, ?4)",
        params![PROJECT_ID, RUN_CONSUMER_KIND, REKEYED_RUN_ID, SEEDED_AT],
    )?;
    conn.execute(
        "INSERT INTO narrative_maintenance_finding_observations
            (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
             reason_code, evidence_freshness_snapshot, material_basis_digest,
             observed_at)
         VALUES ('observation-' || ?1, ?2, ?3, 'c2-upgrade-epoch', ?1,
                 ?4 || ':' || ?3, 'source-missing', 'source-missing',
                 'c2-upgrade-basis-digest', ?5)",
        params![
            REKEYED_EDGE_ID,
            PROJECT_ID,
            REKEYED_RUN_ID,
            RUN_CONSUMER_KIND,
            SEEDED_AT
        ],
    )?;
    Ok(())
}

/// Two dispositions: one a person signed, and one an older build left
/// unattributed. SCHEMA 25 has to keep the first and give the second the
/// explicit legacy sentinel rather than dropping it or claiming it.
fn seed_attention(conn: &Connection, era: i32) -> anyhow::Result<()> {
    let rows = [
        (ATTENTION_FINDING_KEY, Some(ATTENTION_ACTOR_ID)),
        (UNATTRIBUTED_ATTENTION_FINDING_KEY, None),
    ];
    for (finding_key, actor) in rows {
        if era < 25 {
            conn.execute(
                "INSERT INTO narrative_maintenance_attention
                    (project_id, finding_key, disposition, material_basis_digest,
                     snoozed_until, set_at, set_by)
                 VALUES (?1, ?2, 'dismissed', 'c2-upgrade-basis-digest', NULL, ?3, ?4)",
                params![PROJECT_ID, finding_key, SEEDED_AT, actor],
            )?;
        } else {
            conn.execute(
                "INSERT INTO narrative_maintenance_attention
                    (project_id, finding_key, disposition, material_basis_digest,
                     snoozed_until, set_at, actor_id, request_id, payload_digest,
                     reason, version)
                 VALUES (?1, ?2, 'dismissed', 'c2-upgrade-basis-digest', NULL, ?3,
                         ?4, 'legacy-migration-v25', 'legacy-migration-v25', NULL, 1)",
                params![
                    PROJECT_ID,
                    finding_key,
                    SEEDED_AT,
                    actor.unwrap_or(LEGACY_ACTOR_SENTINEL)
                ],
            )?;
        }
    }
    Ok(())
}

fn seed_v24_rows(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO narrative_semantic_index_metadata
            (project_id, index_key, generation, built_at, source_digest,
             dependency_set_digest, dirty_cache_flag)
         VALUES (?1, 'embeddings', 3, ?2, 'c2-upgrade-source-digest',
                 'c2-upgrade-dependency-digest', 0)",
        params![PROJECT_ID, SEEDED_AT],
    )?;
    conn.execute(
        "INSERT INTO narrative_maintenance_repair_leases
            (project_id, lease_owner, verify_run_id, repair_plan_digest,
             semantic_epoch_id, claimed_at, expires_at)
         VALUES (?1, 'c2-upgrade-owner', ?2, 'c2-upgrade-repair-digest',
                 'c2-upgrade-epoch', ?3, '2126-08-15T00:00:00.000Z')",
        params![PROJECT_ID, REPAIRED_RUN_ID, SEEDED_AT],
    )?;
    Ok(())
}

// -- read helpers shared by the upgrade-path assertions ---------------------

pub fn read_only_connection(db_path: &Path) -> Connection {
    Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open the workspace read-only")
}

pub fn user_version(conn: &Connection) -> i32 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("read user_version")
}

pub fn table_has_column(conn: &Connection, table: &str, column: &str) -> bool {
    conn.prepare(&format!("PRAGMA table_info({table})"))
        .expect("prepare table_info")
        .query_map([], |row| row.get::<_, String>("name"))
        .expect("query table_info")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect table_info")
        .iter()
        .any(|name| name == column)
}

/// `(ordinal, name)` for every column of `table`, in `PRAGMA table_info`
/// order.
///
/// Exists to compare an upgraded workspace against a fresh one. `ALTER TABLE
/// ADD COLUMN` appends, so a column the fresh DDL declares anywhere but last
/// gets a different ordinal on the two paths -- and the schema contract
/// compares by ordinal, which is what makes that a real divergence rather
/// than a cosmetic one.
pub fn table_column_ordinals(conn: &Connection, table: &str) -> Vec<(i64, String)> {
    conn.prepare(&format!("PRAGMA table_info({table})"))
        .expect("prepare table_info")
        .query_map([], |row| {
            Ok((row.get::<_, i64>("cid")?, row.get::<_, String>("name")?))
        })
        .expect("query table_info")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect table_info")
}

/// A database at the current schema, created from scratch rather than
/// upgraded -- the comparison target for [`table_column_ordinals`].
pub fn fresh_workspace_connection(label: &str) -> (PathBuf, Connection) {
    let root = temp_workspace(&format!("{label}-fresh"));
    let db_path = root.join("grimodex.db");
    {
        let db = Database::new(&db_path).expect("create a fresh workspace database");
        db.migrate().expect("migrate a fresh workspace");
    }
    let conn = Connection::open(&db_path).expect("open the fresh workspace");
    (root, conn)
}

pub fn index_exists(conn: &Connection, index: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1
         )",
        params![index],
        |row| row.get(0),
    )
    .expect("probe index")
}

pub fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
         )",
        params![table],
        |row| row.get(0),
    )
    .expect("probe table")
}

pub fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .expect("count rows")
}

pub fn contribution_identity(conn: &Connection, id: &str) -> String {
    conn.query_row(
        "SELECT target_object_identity FROM narrative_application_contributions
          WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .expect("read the Contribution identity")
}

pub fn contribution_ownership(conn: &Connection, id: &str) -> String {
    conn.query_row(
        "SELECT maintenance_ownership FROM narrative_application_contributions
          WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .expect("read the Contribution ownership")
}

pub fn contribution_baseline(conn: &Connection, id: &str) -> Option<i64> {
    conn.query_row(
        "SELECT baseline_sequence FROM narrative_application_contributions
          WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .expect("read the Contribution baseline")
}

pub fn edge_identity(conn: &Connection, edge_id: &str) -> String {
    conn.query_row(
        "SELECT source_object_identity FROM narrative_dependency_edges WHERE id = ?1",
        params![edge_id],
        |row| row.get(0),
    )
    .expect("read the Edge identity")
}

pub fn edge_owning_run(conn: &Connection, edge_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT owning_run_id FROM narrative_dependency_edges WHERE id = ?1",
        params![edge_id],
        |row| row.get(0),
    )
    .expect("read the Edge's owning run")
}

/// Every `(consumer_kind, consumer_key, source_object_identity)` in the
/// project, ordered. The re-key is observable only as a change to this whole
/// set -- a per-Edge lookup would miss both the Revision Edge it adds and the
/// Run Edge it removes.
pub fn edge_consumers(conn: &Connection) -> Vec<(String, String, String)> {
    conn.prepare(
        "SELECT consumer_kind, consumer_key, source_object_identity
           FROM narrative_dependency_edges
          WHERE project_id = ?1
          ORDER BY consumer_kind, consumer_key, source_object_identity",
    )
    .expect("prepare")
    .query_map(params![PROJECT_ID], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })
    .expect("query")
    .collect::<Result<Vec<_>, _>>()
    .expect("collect the project's Edge Consumers")
}

/// `(edges, edge states, consumer freshness, finding observations)` for one
/// Run-grained Consumer -- the four derived tables the Gate C2 migration
/// block deletes from, counted together so a partial unwind cannot hide
/// behind a table that happened to survive.
///
/// Scoped to a Consumer rather than counted project-wide, because the SCHEMA
/// 28 identity repair runs *before* the block's savepoint and legitimately
/// invalidates the derived state of the Consumers whose identities it
/// rewrote. A project-wide count would fold that intended deletion into the
/// same number as an unintended one. Pass a Consumer the repair does not
/// touch.
pub fn c2_derived_state_counts(conn: &Connection, consumer_key: &str) -> (i64, i64, i64, i64) {
    let scoped = |sql: &str| -> i64 {
        conn.query_row(
            sql,
            params![PROJECT_ID, RUN_CONSUMER_KIND, consumer_key],
            |row| row.get(0),
        )
        .unwrap_or_else(|error| panic!("count for '{consumer_key}': {error}"))
    };
    (
        scoped(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
        ),
        scoped(
            "SELECT COUNT(*) FROM narrative_dependency_edge_states s
               JOIN narrative_dependency_edges e ON e.id = s.edge_id
              WHERE e.project_id = ?1 AND e.consumer_kind = ?2 AND e.consumer_key = ?3",
        ),
        scoped(
            "SELECT COUNT(*) FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
        ),
        scoped(
            "SELECT COUNT(*) FROM narrative_maintenance_finding_observations
              WHERE project_id = ?1 AND finding_key = ?2 || ':' || ?3",
        ),
    )
}

pub fn consumer_freshness_rows(conn: &Connection, consumer_key: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM narrative_consumer_freshness
          WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
        params![PROJECT_ID, RUN_CONSUMER_KIND, consumer_key],
        |row| row.get(0),
    )
    .expect("count Consumer Freshness rows")
}

pub fn attention_actor(conn: &Connection, finding_key: &str) -> String {
    conn.query_row(
        "SELECT actor_id FROM narrative_maintenance_attention
          WHERE project_id = ?1 AND finding_key = ?2",
        params![PROJECT_ID, finding_key],
        |row| row.get(0),
    )
    .expect("read the Attention actor")
}

pub fn has_c2_identity_marker(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM schema_data_migrations
             WHERE migration_id = 'narrative-c2-identity-v28' AND contract_version >= 2
         )",
        [],
        |row| row.get(0),
    )
    .expect("probe the C2 identity marker")
}
