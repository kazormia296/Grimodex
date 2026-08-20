//! Gate C2-4 follow-up hardening: `migrate()` over a real SCHEMA 23-30
//! workspace.
//!
//! Every Gate C2 migration test that existed before this one ran against a
//! scratch in-memory database holding only the handful of tables one
//! migration reads. That shape cannot reach the hazards this upgrade actually
//! has, because all four of them come from the *rest* of the schema being
//! there already:
//!
//!   1. the base DDL runs `CREATE TABLE IF NOT EXISTS` against the shape the
//!      workspace already has, so an index naming a SCHEMA 29 column would
//!      fail with `no such column: commit_id` and the workspace would stop
//!      opening. `idx_narrative_application_contributions_commit` is created
//!      after the rebuild for exactly this reason;
//!   2. the SCHEMA 29 rebuild, the SCHEMA 28 completion marker and the SCHEMA
//!      30 Consumer grain re-key all write tables the others read, and
//!      `migrate_impl` otherwise runs in autocommit, so the
//!      `narrative_c2_schema_30` savepoint is what makes a failure anywhere
//!      among them recoverable;
//!   3. the rebuild fails closed on an orphaned Contribution
//!      (`NEX_CONTRIBUTION_ORPHAN`), which is only a safe thing to do if the
//!      unwind actually restores the workspace it refused to upgrade;
//!   4. the re-key deletes the Run-grained Edges it replaced, so an
//!      interruption *after* that delete has to land wholly before or wholly
//!      after -- a workspace whose Edges moved but whose completion marker
//!      says they did not would have the re-key run again over a graph it had
//!      already re-keyed.
//!
//! These go through the public entry points — `Database::migrate()` and the
//! shadow migration supervisor — rather than the migration helpers, because
//! the helpers are where the coverage already was.

#[path = "support/c2_era_workspace.rs"]
mod c2_era_workspace;

use std::fs;

use c2_era_workspace::{
    attention_actor, c2_derived_state_counts, consumer_freshness_rows, contribution_baseline,
    contribution_identity, contribution_ownership, count, edge_consumers, edge_identity,
    edge_owning_run, fresh_workspace_connection, has_c2_identity_marker, index_exists,
    read_only_connection, seed_c2_era_workspace, table_column_ordinals, table_exists,
    table_has_column, user_version, EraWorkspace, APPLICATION_ID, APPLY_EVENT_SEQUENCE,
    ATTENTION_ACTOR_ID, ATTENTION_FINDING_KEY, CANONICAL_CHRONICLE_IDENTITY,
    CANONICAL_CODEX_IDENTITY, CANONICAL_EDGE_IDENTITY, CHRONICLE_CONTRIBUTION_ID, COMMIT_ID,
    EARLIER_OTHER_APPLY_EVENT_SEQUENCE, HUMAN_OWNED_CONTRIBUTION_ID,
    LATER_OTHER_APPLY_EVENT_SEQUENCE, LEGACY_ACTOR_SENTINEL, MAINTAINED_CONTRIBUTION_ID,
    NEWEST_C2_ERA, NEWEST_PRE_V29_ERA, OLDEST_C2_ERA, PROJECT_ID, PROPOSAL_ID,
    REKEYED_EDGE_IDENTITY, REKEYED_REVISION_ID, REKEYED_RUN_ID, REPAIRED_EDGE_ID, REPAIRED_RUN_ID,
    REVISION_CONSUMER_KIND, REVISION_ID, RUN_CONSUMER_KIND, UNATTRIBUTED_ATTENTION_FINDING_KEY,
    UNTOUCHED_EDGE_ID, UNTOUCHED_EDGE_IDENTITY, UNTOUCHED_RUN_ID,
};
use grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants;
use grimodex_core::SCHEMA_VERSION;
use grimodex_db::migration_supervisor::{self, WorkspaceOpenDbOutcome};
use rusqlite::{params, Connection};
use serde_json::Value;

const COMMIT_INDEX: &str = "idx_narrative_application_contributions_commit";

/// The project's Edge Consumers after a Gate C2 block that did not complete
/// -- three Run-grained Edges, one per seeded Run.
///
/// The repaired Edge is canonical here even on a SCHEMA 23-27 workspace: the
/// SCHEMA 28 identity repair runs *before* the block's savepoint, so it is
/// not part of what a refusal or an interruption unwinds.
fn run_grained_edge_consumers() -> Vec<(String, String, String)> {
    let mut rows = vec![
        (
            RUN_CONSUMER_KIND.to_string(),
            REKEYED_RUN_ID.to_string(),
            REKEYED_EDGE_IDENTITY.to_string(),
        ),
        (
            RUN_CONSUMER_KIND.to_string(),
            REPAIRED_RUN_ID.to_string(),
            CANONICAL_EDGE_IDENTITY.to_string(),
        ),
        (
            RUN_CONSUMER_KIND.to_string(),
            UNTOUCHED_RUN_ID.to_string(),
            UNTOUCHED_EDGE_IDENTITY.to_string(),
        ),
    ];
    rows.sort();
    rows
}

/// ...and after it: the Revision takes the read its own Source Basis names.
fn rekeyed_edge_consumers() -> Vec<(String, String, String)> {
    let mut rows = vec![
        (
            RUN_CONSUMER_KIND.to_string(),
            REPAIRED_RUN_ID.to_string(),
            CANONICAL_EDGE_IDENTITY.to_string(),
        ),
        (
            RUN_CONSUMER_KIND.to_string(),
            UNTOUCHED_RUN_ID.to_string(),
            UNTOUCHED_EDGE_IDENTITY.to_string(),
        ),
        (
            REVISION_CONSUMER_KIND.to_string(),
            REKEYED_REVISION_ID.to_string(),
            REKEYED_EDGE_IDENTITY.to_string(),
        ),
    ];
    rows.sort();
    rows
}

/// Every marker on the Gate C2 upgrade path, oldest first.
fn c2_eras() -> impl Iterator<Item = i32> {
    OLDEST_C2_ERA..=NEWEST_C2_ERA
}

/// The markers that still need the SCHEMA 29 Contribution rebuild. A SCHEMA
/// 29 workspace was written *by* that rebuild, so the hazards belonging to it
/// -- the index it cannot carry beforehand, the savepoint that unwinds it, the
/// orphan it refuses -- have nothing to act on there, and asserting them for
/// era 29 would be asserting something untrue rather than something stricter.
fn pre_v29_eras() -> impl Iterator<Item = i32> {
    OLDEST_C2_ERA..29
}

/// Hazard 1, pinned from the workspace's side rather than by reading the
/// migration's source: on a genuine SCHEMA 23-28 database the Contribution
/// index the base DDL batch would carry cannot be created at all. That is why
/// it lives after the rebuild, and this is the fixture's own proof that it
/// really is in the shape a fresh database can never be in.
#[test]
fn a_c2_era_workspace_cannot_carry_the_commit_index_before_migrating() {
    for era in pre_v29_eras() {
        let workspace = seed_c2_era_workspace("pre-shape", era);
        let conn = read_only_connection(&workspace.db_path);

        assert_eq!(user_version(&conn), era);
        assert!(
            !table_has_column(&conn, "narrative_application_contributions", "commit_id"),
            "SCHEMA {era} predates the Contribution provenance columns"
        );
        assert!(
            !index_exists(&conn, COMMIT_INDEX),
            "SCHEMA {era} cannot already have the SCHEMA 29 index"
        );
        assert!(
            !has_current_schema_checkpoint_invariants(&conn).expect("checkpoint"),
            "a SCHEMA {era} workspace must not satisfy the current checkpoint, \
             or migrate() takes a fast path and never rebuilds"
        );

        // The rest of the era's shape, pinned here so the upgrade assertions
        // below cannot quietly degrade into "a current database wearing an old
        // user_version" if the rewind ever stops matching the schema.
        assert_eq!(
            table_exists(&conn, "narrative_maintenance_repair_leases"),
            workspace.has_v24_tables(),
            "the Repair lease table arrives at SCHEMA 24 (era {era})"
        );
        assert_eq!(
            table_exists(&conn, "narrative_semantic_index_metadata"),
            workspace.has_v24_tables(),
            "the Semantic Index metadata table arrives at SCHEMA 24 (era {era})"
        );
        if workspace.has_v24_tables() {
            assert_eq!(
                table_has_column(
                    &conn,
                    "narrative_maintenance_repair_leases",
                    "active_run_id"
                ),
                era >= 27,
                "a Repair lease names its Run only from SCHEMA 27 (era {era})"
            );
        }
        assert_eq!(
            table_has_column(
                &conn,
                "narrative_consumer_freshness",
                "dependency_set_digest"
            ),
            era >= 24,
            "Verify's dependency-set baseline arrives at SCHEMA 24 (era {era})"
        );
        assert_eq!(
            table_has_column(&conn, "narrative_extraction_runs", "request_id"),
            era >= 26,
            "a Run records its request identity only from SCHEMA 26 (era {era})"
        );
        assert_eq!(
            table_has_column(&conn, "narrative_maintenance_attention", "actor_id"),
            era >= 25,
            "Attention gains a mandatory actor at SCHEMA 25 (era {era})"
        );
        assert_eq!(
            table_has_column(&conn, "narrative_maintenance_attention", "set_by"),
            era < 25,
            "SCHEMA 25 replaces the nullable set_by with actor_id (era {era})"
        );
        assert_eq!(
            has_c2_identity_marker(&conn),
            era >= 28,
            "only a workspace written by the SCHEMA 28 build carries its completion \
             marker (era {era})"
        );
        drop(conn);

        // The failure the ordering comment describes, reproduced verbatim.
        let writable =
            rusqlite::Connection::open(&workspace.db_path).expect("open the era workspace");
        let error = writable
            .execute_batch(&format!(
                "CREATE INDEX IF NOT EXISTS {COMMIT_INDEX}
                    ON narrative_application_contributions(project_id, commit_id);"
            ))
            .expect_err("the base DDL batch must not be able to create this index");
        assert!(
            error.to_string().contains("no such column: commit_id"),
            "unexpected error on SCHEMA {era}: {error}"
        );
    }
}

/// The upgrade itself: every marker on the path reaches the current schema,
/// satisfies the checkpoint, and ends up with the physical objects each
/// intermediate migration owns.
#[test]
fn migrate_upgrades_every_c2_era_workspace_to_the_current_schema() {
    for era in c2_eras() {
        let workspace = seed_c2_era_workspace("upgrade", era);
        let db = workspace.open();
        db.migrate()
            .unwrap_or_else(|error| panic!("migrate a SCHEMA {era} workspace: {error:#}"));
        drop(db);

        let conn = read_only_connection(&workspace.db_path);
        assert_eq!(
            user_version(&conn),
            SCHEMA_VERSION,
            "SCHEMA {era} workspace should reach the current marker"
        );
        assert!(
            has_current_schema_checkpoint_invariants(&conn).expect("checkpoint"),
            "SCHEMA {era} workspace should satisfy the current checkpoint"
        );
        assert!(
            index_exists(&conn, COMMIT_INDEX),
            "the SCHEMA 29 commit index must exist after the rebuild (from SCHEMA {era})"
        );
        assert!(
            has_c2_identity_marker(&conn),
            "the SCHEMA 28 completion marker must be recorded (from SCHEMA {era})"
        );

        // SCHEMA 30 put `owning_run_id` last in the fresh DDL on purpose:
        // `ALTER TABLE ADD COLUMN` appends, and the schema contract compares
        // by ordinal, so declaring it anywhere else would make an upgraded
        // workspace and a fresh one disagree on a table neither reports as
        // broken. Only comparing the two shapes catches that.
        {
            let (_fresh_root, fresh) = fresh_workspace_connection("edge-shape");
            assert_eq!(
                table_column_ordinals(&conn, "narrative_dependency_edges"),
                table_column_ordinals(&fresh, "narrative_dependency_edges"),
                "an upgraded SCHEMA {era} workspace must have the same Edge column \
                 ordinals as a fresh database"
            );
        }

        // SCHEMA 30: every Edge names the Run that declared it. The backfill
        // reads that off `consumer_key`, which is only the right answer while
        // every Consumer is a Run -- which is exactly why it is copied once
        // here instead of being re-derived at every read.
        for (edge_id, run_id) in [
            (REPAIRED_EDGE_ID, REPAIRED_RUN_ID),
            (UNTOUCHED_EDGE_ID, UNTOUCHED_RUN_ID),
        ] {
            assert_eq!(
                edge_owning_run(&conn, edge_id).as_deref(),
                Some(run_id),
                "the Edge's declaring Run must survive the upgrade (from SCHEMA {era})"
            );
        }

        // SCHEMA 30's re-key: the one Consumer whose Revision has a durable
        // Source Basis moves onto that Revision; the two that have none stay
        // under their Run, because there is nothing to attribute their read
        // to and inventing one is exactly what C2-2 forbids.
        assert_eq!(
            edge_consumers(&conn),
            rekeyed_edge_consumers(),
            "the re-key must move only the Edge its Revision's Source Basis \
             accounts for (from SCHEMA {era})"
        );
        // SCHEMA 24's Run Kind Policy objects.
        for table in [
            "narrative_semantic_index_metadata",
            "narrative_maintenance_repair_leases",
        ] {
            assert!(
                table_exists(&conn, table),
                "'{table}' must exist after migrating from SCHEMA {era}"
            );
        }
        assert_eq!(
            count(&conn, "narrative_maintenance_repair_leases"),
            i64::from(workspace.has_v24_tables()),
            "a Repair lease claimed before the upgrade must survive it (from SCHEMA {era})"
        );
        assert!(
            table_has_column(
                &conn,
                "narrative_maintenance_repair_leases",
                "active_run_id"
            ),
            "SCHEMA 27 binds a lease to its Run (from SCHEMA {era})"
        );
        drop(conn);

        // SCHEMA 24's widened `run_kind` vocabulary, exercised rather than
        // read off the DDL: the CHECK is the only thing that admits it.
        let db = workspace.open();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, version, run_kind)
                 VALUES ('c2-upgrade-verify-run', ?1, 'chronicle.verify', '{}', '{}',
                         'c2-upgrade-verify-digest', 'pending', '{}',
                         '2026-08-15T00:00:00.000Z', 0, 'dependency-verify')",
                params![PROJECT_ID],
            )?;
            Ok(())
        })
        .unwrap_or_else(|error| {
            panic!("SCHEMA 24 run_kind vocabulary after upgrading from {era}: {error:#}")
        });
        drop(db);

        // SCHEMA 25's mandatory actor: a signed disposition keeps its author,
        // an unattributed one gets the explicit sentinel.
        let conn = read_only_connection(&workspace.db_path);
        assert_eq!(
            attention_actor(&conn, ATTENTION_FINDING_KEY),
            ATTENTION_ACTOR_ID,
            "SCHEMA 25 must not reattribute a signed disposition (from SCHEMA {era})"
        );
        assert_eq!(
            attention_actor(&conn, UNATTRIBUTED_ATTENTION_FINDING_KEY),
            LEGACY_ACTOR_SENTINEL,
            "SCHEMA 25 must mark an unattributed disposition, not drop it (from SCHEMA {era})"
        );
    }
}

/// A real SCHEMA 30-shaped workspace has no C2-3 columns yet. In particular,
/// an old diagnostic row may have lost its Edge subject. The v31 migration
/// must add nullable identity columns, leave that row unresolved, and seed a
/// `new` lifecycle baseline only for the Edge-backed observations it can
/// prove.
#[test]
fn schema_30_upgrade_preserves_unresolved_observations_and_seeds_lifecycle_baseline() {
    let workspace = seed_c2_era_workspace("finding-identity-v31", 30);
    {
        let conn = Connection::open(&workspace.db_path).expect("open v30 workspace");
        conn.execute(
            "INSERT INTO narrative_maintenance_finding_observations
                (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
                 reason_code, evidence_freshness_snapshot, material_basis_digest, observed_at)
             VALUES ('legacy-no-edge', ?1, ?2, 'c2-upgrade-epoch', NULL,
                     'narrative-extraction-run:legacy-no-edge', 'source-missing',
                     'source-missing', 'legacy-no-edge-basis', ?3)",
            params![PROJECT_ID, REPAIRED_RUN_ID, "2026-08-15T00:00:01.000Z"],
        )
        .expect("seed v30 observation without edge");
    }

    let db = workspace.open();
    db.migrate().expect("upgrade SCHEMA 30 to 31");
    db.with_conn(|conn| {
        let legacy_identity: Option<String> = conn.query_row(
            "SELECT finding_identity FROM narrative_maintenance_finding_observations
              WHERE id = 'legacy-no-edge'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(legacy_identity, None);
        let unresolved_status: String = conn.query_row(
            "SELECT identity_resolution_status FROM narrative_maintenance_attention
              WHERE finding_key = ?1",
            params![UNATTRIBUTED_ATTENTION_FINDING_KEY],
            |row| row.get(0),
        )?;
        assert_eq!(unresolved_status, "legacy-unresolved");
        let baseline_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_finding_lifecycle
              WHERE project_id = ?1",
            params![PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_eq!(
            baseline_count, 2,
            "only surviving Edge-backed rows seed baselines"
        );
        let legacy_baseline_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_finding_lifecycle
              WHERE finding_key = 'narrative-extraction-run:legacy-no-edge'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(legacy_baseline_count, 0);
        Ok(())
    })
    .expect("inspect SCHEMA 31 identity migration");
}

/// SCHEMA 29 gives every Contribution the provenance of the Application it
/// already pointed at, the baseline its own apply event landed on, and the
/// ownership the Field Authority ledger had already decided — without losing
/// a row.
#[test]
fn migrate_preserves_contribution_attribution_and_reconstructs_its_provenance() {
    for era in c2_eras() {
        let workspace = seed_c2_era_workspace("attribution", era);
        let db = workspace.open();
        db.migrate()
            .unwrap_or_else(|error| panic!("migrate a SCHEMA {era} workspace: {error:#}"));
        drop(db);

        let conn = read_only_connection(&workspace.db_path);
        assert_eq!(
            count(&conn, "narrative_application_contributions"),
            3,
            "no Contribution may be dropped by the rebuild (from SCHEMA {era})"
        );

        for id in [
            HUMAN_OWNED_CONTRIBUTION_ID,
            MAINTAINED_CONTRIBUTION_ID,
            CHRONICLE_CONTRIBUTION_ID,
        ] {
            let (application_id, commit_id, proposal_id, revision_id, operation_id): (
                String,
                String,
                String,
                String,
                Option<String>,
            ) = conn
                .query_row(
                    "SELECT application_id, commit_id, proposal_id, revision_id, operation_id
                       FROM narrative_application_contributions WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .unwrap_or_else(|error| {
                    panic!("read '{id}' after migrating from SCHEMA {era}: {error}")
                });
            assert_eq!(application_id, APPLICATION_ID);
            assert_eq!(
                commit_id, COMMIT_ID,
                "provenance comes from the Application"
            );
            assert_eq!(proposal_id, PROPOSAL_ID);
            assert_eq!(revision_id, REVISION_ID);
            assert_eq!(
                operation_id, None,
                "an operation cannot be identified retroactively and must not be invented"
            );
            assert_eq!(
                contribution_baseline(&conn, id),
                Some(APPLY_EVENT_SEQUENCE),
                "the baseline is this commit's own apply event, not the project's \
                 first ({EARLIER_OTHER_APPLY_EVENT_SEQUENCE}) or last \
                 ({LATER_OTHER_APPLY_EVENT_SEQUENCE}) -- the fixture straddles it on \
                 both sides so dropping entity_id from the grouping cannot pass \
                 (from SCHEMA {era})"
            );
        }

        assert_eq!(
            contribution_ownership(&conn, HUMAN_OWNED_CONTRIBUTION_ID),
            "user-owned",
            "the Field Authority ledger already recorded this field as the author's \
             (from SCHEMA {era})"
        );
        for id in [MAINTAINED_CONTRIBUTION_ID, CHRONICLE_CONTRIBUTION_ID] {
            assert_eq!(
                contribution_ownership(&conn, id),
                "maintained",
                "'{id}' is a field nobody claimed and must not be stamped \
                 (from SCHEMA {era})"
            );
        }
    }
}

/// SCHEMA 28's identity repair, seen end to end: the double-prefixed Edge the
/// pre-#535 Backfill wrote is collapsed, the Contributions written in the two
/// legacy vocabularies land on the canonical one, and the derived state that
/// was decided against the identities they replaced is discarded.
///
/// A workspace already stamped 28 was written by the build that did all of
/// that, so it carries the completion marker and must be left alone — that the
/// discard does *not* repeat is as much a part of the contract as that it
/// happens once.
#[test]
fn migrate_repairs_schema_28_identities_end_to_end() {
    for era in c2_eras() {
        let workspace = seed_c2_era_workspace("identity", era);
        let db = workspace.open();
        db.migrate()
            .unwrap_or_else(|error| panic!("migrate a SCHEMA {era} workspace: {error:#}"));
        drop(db);

        let conn = read_only_connection(&workspace.db_path);
        assert_eq!(
            edge_identity(&conn, REPAIRED_EDGE_ID),
            CANONICAL_EDGE_IDENTITY,
            "the doubled Source prefix must be collapsed (from SCHEMA {era})"
        );
        assert_eq!(
            edge_identity(&conn, UNTOUCHED_EDGE_ID),
            UNTOUCHED_EDGE_IDENTITY,
            "an already-canonical Edge must be left alone (from SCHEMA {era})"
        );
        assert_eq!(
            contribution_identity(&conn, HUMAN_OWNED_CONTRIBUTION_ID),
            CANONICAL_CODEX_IDENTITY,
            "the writer-row vocabulary must be rewritten (from SCHEMA {era})"
        );
        assert_eq!(
            contribution_identity(&conn, CHRONICLE_CONTRIBUTION_ID),
            CANONICAL_CHRONICLE_IDENTITY,
            "the Field Authority vocabulary must be rewritten (from SCHEMA {era})"
        );

        let expected_derived_rows = if workspace.needs_identity_repair() {
            0
        } else {
            2
        };
        for table in [
            "narrative_dependency_edge_states",
            "narrative_consumer_freshness",
            "narrative_maintenance_finding_observations",
        ] {
            assert_eq!(
                count(&conn, table),
                expected_derived_rows,
                "'{table}' after migrating from SCHEMA {era}: derived state decided \
                 against a replaced identity is discarded exactly once, and a \
                 workspace that already carries the completion marker keeps its own"
            );
        }
    }
}

/// The marker and the rebuild's own guard are what stop the upgrade repeating.
/// A second open must find nothing to do and must leave every reconstructed
/// value where the first one put it.
#[test]
fn migrate_is_idempotent_on_an_upgraded_c2_era_workspace() {
    for era in c2_eras() {
        let workspace = seed_c2_era_workspace("idempotent", era);
        let db = workspace.open();
        db.migrate().expect("first upgrade");
        db.migrate().expect("second open must find nothing to do");
        db.migrate().expect("third open must still find nothing");
        drop(db);

        let conn = read_only_connection(&workspace.db_path);
        assert_eq!(user_version(&conn), SCHEMA_VERSION);
        assert!(has_current_schema_checkpoint_invariants(&conn).expect("checkpoint"));
        assert_eq!(count(&conn, "narrative_application_contributions"), 3);
        assert_eq!(
            contribution_ownership(&conn, HUMAN_OWNED_CONTRIBUTION_ID),
            "user-owned",
            "a repeated open must not reset ownership (from SCHEMA {era})"
        );
        assert_eq!(
            contribution_baseline(&conn, HUMAN_OWNED_CONTRIBUTION_ID),
            Some(APPLY_EVENT_SEQUENCE)
        );
        assert_eq!(
            edge_identity(&conn, REPAIRED_EDGE_ID),
            CANONICAL_EDGE_IDENTITY
        );
    }
}

/// Hazards 2 and 3 together. An orphaned Contribution stops the SCHEMA 29
/// rebuild, and the `narrative_c2_schema_30` savepoint has to put the
/// workspace back as it was — including the derived state the completion
/// marker would otherwise have discarded unconditionally on its way past.
///
/// The untouched Consumer is the witness. The SCHEMA 28 Edge repair runs
/// *before* the savepoint and durably clears the Consumer whose identity it
/// changed, so only a Consumer it never touched can distinguish "the marker
/// step was rolled back" from "the marker step never ran".
#[test]
fn an_orphan_contribution_fails_closed_and_unwinds_the_gate_c2_savepoint() {
    for era in [OLDEST_C2_ERA, NEWEST_PRE_V29_ERA] {
        let workspace = seed_c2_era_workspace("orphan", era);
        {
            let db = workspace.open();
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_application_contributions
                        (id, project_id, application_id, target_object_identity,
                         field_path, target_state, created_at)
                     VALUES ('c2-upgrade-orphan', ?1, 'c2-upgrade-application-gone',
                             'codex-entry:c2-upgrade-orphan', '/name', 'unchanged',
                             '2026-08-15T00:00:00.000Z')",
                    params![PROJECT_ID],
                )?;
                Ok(())
            })
            .expect("seed an orphaned Contribution");

            let error = db
                .migrate()
                .expect_err("an orphaned Contribution must stop the upgrade");
            assert!(
                format!("{error:#}").contains("NEX_CONTRIBUTION_ORPHAN"),
                "unexpected error on SCHEMA {era}: {error:#}"
            );
        }

        let conn = read_only_connection(&workspace.db_path);
        assert_eq!(
            user_version(&conn),
            era,
            "a refused upgrade must not advance the marker"
        );
        assert!(
            !table_has_column(&conn, "narrative_application_contributions", "commit_id"),
            "the rebuild's DROP+RENAME must be rolled back, not left half done"
        );
        assert_eq!(
            count(&conn, "narrative_application_contributions"),
            4,
            "every Contribution, orphan included, must survive the refusal"
        );
        assert_eq!(
            consumer_freshness_rows(&conn, UNTOUCHED_RUN_ID),
            1,
            "the only step that can refuse must run before the only step that \
             destroys: Consumer Freshness is the durable Freshness authority, and a \
             workspace nothing can rebuild until a human repairs the orphan must not \
             be left without it"
        );
        // Freshness is the authority, but it is not the only thing the block
        // discards: `finish_narrative_c2_identity_data_migration_v28` opens
        // with three unconditional DELETEs, and the re-key deletes Edges. All
        // four tables have to be intact, or "the workspace is as we found it"
        // is only true of the one this test happened to look at.
        for consumer_key in [UNTOUCHED_RUN_ID, REKEYED_RUN_ID] {
            assert_eq!(
                c2_derived_state_counts(&conn, consumer_key),
                (1, 1, 1, 1),
                "a refused upgrade must not have discarded '{consumer_key}' derived \
                 state on the way to refusing (SCHEMA {era})"
            );
        }
        assert_eq!(
            edge_consumers(&conn),
            run_grained_edge_consumers(),
            "the Consumer grain re-key must be unwound with the rest of the block \
             (SCHEMA {era})"
        );
        assert_eq!(
            has_c2_identity_marker(&conn),
            !workspace.needs_identity_repair(),
            "a refused upgrade must leave the SCHEMA 28 completion marker exactly as it \
             found it: absent on a workspace that still needs the repair, and untouched \
             on one written by the build that already did it"
        );
        drop(conn);

        // And the refusal has to be recoverable rather than terminal: once the
        // orphan is dealt with, the same workspace upgrades normally.
        let db = workspace.open();
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_application_contributions WHERE id = 'c2-upgrade-orphan'",
                [],
            )?;
            Ok(())
        })
        .expect("remove the orphan");
        db.migrate()
            .unwrap_or_else(|error| panic!("upgrade a repaired SCHEMA {era} workspace: {error:#}"));
        drop(db);

        let conn = read_only_connection(&workspace.db_path);
        assert_eq!(user_version(&conn), SCHEMA_VERSION);
        assert!(has_current_schema_checkpoint_invariants(&conn).expect("checkpoint"));
        assert_eq!(count(&conn, "narrative_application_contributions"), 3);
        assert_eq!(
            contribution_baseline(&conn, HUMAN_OWNED_CONTRIBUTION_ID),
            Some(APPLY_EVENT_SEQUENCE)
        );
        assert_eq!(
            edge_consumers(&conn),
            rekeyed_edge_consumers(),
            "and the re-key the refusal unwound must land on the retry (SCHEMA {era})"
        );
    }
}

/// The other half of the same invariant: interrupted rather than refused.
///
/// The failpoint is a trigger that raises on the Consumer grain marker write,
/// which is the block's last statement -- so the Run-grained Edges have
/// already been deleted and the Revision-grained ones already inserted when
/// it fires. A crash there must not leave a workspace whose Edges moved but
/// whose marker says the move never happened, because that marker is the only
/// thing stopping the next open from re-running the re-key over a graph that
/// has already been re-keyed.
///
/// Then the failpoint is removed and the workspace re-opened, because "rolls
/// back cleanly" is only half the requirement: the other half is that the
/// rolled-back workspace is still upgradable, which a partial unwind would
/// quietly not be.
#[test]
fn an_interrupted_c2_upgrade_lands_wholly_before_or_wholly_after() {
    for era in c2_eras() {
        let workspace = seed_c2_era_workspace("interrupted", era);
        {
            let db = workspace.open();
            db.with_conn(|conn| {
                conn.execute_batch(
                    "CREATE TRIGGER c2_consumer_grain_failpoint
                     BEFORE INSERT ON schema_data_migrations
                     WHEN NEW.migration_id = 'narrative-c2-consumer-grain-v30'
                     BEGIN SELECT RAISE(ABORT, 'simulated crash after the Run Edge delete'); END;",
                )?;
                Ok(())
            })
            .expect("arm the failpoint");

            let error = db
                .migrate()
                .expect_err("the failpoint must stop the upgrade");
            // `{:#}` rather than `{}`: the marker write wraps the SQLite error
            // in its own context, so the plain Display shows only the wrapper.
            assert!(
                format!("{error:#}").contains("simulated crash"),
                "unexpected error on SCHEMA {era}: {error:#}"
            );
        }

        let conn = read_only_connection(&workspace.db_path);
        assert_eq!(
            user_version(&conn),
            era,
            "an interrupted upgrade must not advance the marker (SCHEMA {era})"
        );
        assert_eq!(
            edge_consumers(&conn),
            run_grained_edge_consumers(),
            "the deleted Run Edge must be back, and the inserted Revision Edge gone \
             (SCHEMA {era})"
        );
        for consumer_key in [UNTOUCHED_RUN_ID, REKEYED_RUN_ID] {
            assert_eq!(
                c2_derived_state_counts(&conn, consumer_key),
                (1, 1, 1, 1),
                "an interrupted upgrade must land wholly before, not on the derived \
                 state the block had already discarded (SCHEMA {era}, \
                 '{consumer_key}')"
            );
        }
        drop(conn);

        let db = workspace.open();
        db.with_conn(|conn| {
            conn.execute_batch("DROP TRIGGER c2_consumer_grain_failpoint;")?;
            Ok(())
        })
        .expect("disarm the failpoint");
        db.migrate().unwrap_or_else(|error| {
            panic!("a rolled-back SCHEMA {era} workspace must still upgrade: {error:#}")
        });
        drop(db);

        let conn = read_only_connection(&workspace.db_path);
        assert_eq!(user_version(&conn), SCHEMA_VERSION);
        assert!(
            has_current_schema_checkpoint_invariants(&conn).expect("checkpoint"),
            "a workspace that survived an interrupted upgrade must satisfy the \
             checkpoint (SCHEMA {era})"
        );
        assert_eq!(
            edge_consumers(&conn),
            rekeyed_edge_consumers(),
            "the retry must land wholly after (SCHEMA {era})"
        );
    }
}

/// The route a desktop user actually takes. `Database::migrate()` is what the
/// rest of this file drives directly so the savepoint is observable on the
/// real file; the supervisor adds the snapshot, the receipt, and the seal that
/// a released upgrade goes through.
#[test]
fn the_shadow_migration_supervisor_upgrades_a_c2_era_workspace() {
    for era in [OLDEST_C2_ERA, NEWEST_PRE_V29_ERA] {
        let workspace: EraWorkspace = seed_c2_era_workspace("supervisor", era);

        let outcome = migration_supervisor::open_or_migrate_workspace_db(&workspace.root)
            .unwrap_or_else(|error| panic!("shadow migrate a SCHEMA {era} workspace: {error:#}"));
        match outcome {
            WorkspaceOpenDbOutcome::Migrated {
                from_schema,
                to_schema,
                opened,
                receipt_path,
            } => {
                assert_eq!(from_schema, era);
                assert_eq!(to_schema, SCHEMA_VERSION);
                let receipt: Value = serde_json::from_str(
                    &fs::read_to_string(&receipt_path).expect("read the migration receipt"),
                )
                .expect("parse the migration receipt");
                assert_eq!(receipt["fromSchema"], Value::from(era));
                assert_eq!(receipt["toSchema"], Value::from(SCHEMA_VERSION));
                drop(opened);
            }
            other => panic!("expected Migrated for a SCHEMA {era} workspace, got {other:?}"),
        }

        let conn = read_only_connection(&workspace.db_path);
        assert_eq!(user_version(&conn), SCHEMA_VERSION);
        assert!(has_current_schema_checkpoint_invariants(&conn).expect("checkpoint"));
        assert!(index_exists(&conn, COMMIT_INDEX));
        assert_eq!(count(&conn, "narrative_application_contributions"), 3);
        assert_eq!(
            contribution_identity(&conn, HUMAN_OWNED_CONTRIBUTION_ID),
            CANONICAL_CODEX_IDENTITY
        );
        assert_eq!(
            contribution_ownership(&conn, HUMAN_OWNED_CONTRIBUTION_ID),
            "user-owned"
        );
        assert_eq!(
            edge_identity(&conn, REPAIRED_EDGE_ID),
            CANONICAL_EDGE_IDENTITY
        );
        assert_eq!(
            count(&conn, "narrative_extraction_runs"),
            3,
            "the Runs a SCHEMA {era} workspace already had must survive the rebuilds"
        );
        assert!(
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM narrative_extraction_runs WHERE id = ?1)",
                params![REPAIRED_RUN_ID],
                |row| row.get::<_, bool>(0),
            )
            .expect("probe the Run"),
            "the SCHEMA 24 run_kind rebuild must preserve Run rows"
        );
    }
}

/// The half of hazard 2 the orphan cannot reach.
///
/// `NEX_CONTRIBUTION_ORPHAN` is raised before any DDL runs, so nothing is
/// partially applied and nothing has to be undone. The savepoint earns its
/// keep on a failure *inside* the rebuild's batch, which `migrate_impl` would
/// otherwise run in autocommit: each statement of that batch commits on its
/// own, so a failure partway through leaves the scratch
/// `narrative_application_contributions_v29` table behind, and every later
/// open then fails on `CREATE TABLE narrative_application_contributions_v29`
/// -- a workspace that can never be opened again, from a data problem that is
/// trivially repairable.
///
/// Injected through an Application carrying an empty `commit_id`, which the
/// rebuilt table rejects with `CHECK(length(commit_id) > 0)` while copying the
/// rows across. That is a hand-recovered or corrupted workspace rather than
/// one a live writer produces -- `narrative_application_immutable_update` sees
/// to that -- and the point here is the unwind, not the provenance of the bad
/// row.
#[test]
fn a_failure_inside_the_schema_29_rebuild_unwinds_to_the_pre_upgrade_workspace() {
    const BLANK_APPLICATION_ID: &str = "c2-upgrade-application-blank";
    const BLANK_CONTRIBUTION_ID: &str = "c2-upgrade-contribution-blank";

    for era in [OLDEST_C2_ERA, NEWEST_PRE_V29_ERA] {
        let workspace = seed_c2_era_workspace("rebuild-unwind", era);
        {
            let db = workspace.open();
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_proposal_applications
                        (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                         applied_entity_id, created_at)
                     VALUES (?1, '', ?2, ?3, 'codex_entry', 'c2-upgrade-blank',
                             '2026-08-15T00:00:00.000Z')",
                    params![BLANK_APPLICATION_ID, PROPOSAL_ID, REVISION_ID],
                )?;
                conn.execute(
                    "INSERT INTO narrative_application_contributions
                        (id, project_id, application_id, target_object_identity,
                         field_path, target_state, created_at)
                     VALUES (?1, ?2, ?3, 'codex-entry:c2-upgrade-blank', '/name',
                             'unchanged', '2026-08-15T00:00:00.000Z')",
                    params![BLANK_CONTRIBUTION_ID, PROJECT_ID, BLANK_APPLICATION_ID],
                )?;
                Ok(())
            })
            .expect("seed an Application with no usable provenance");

            let error = db
                .migrate()
                .expect_err("the rebuild must not accept an empty commit_id");
            assert!(
                format!("{error:#}")
                    .contains("rebuilding narrative_application_contributions for SCHEMA 29"),
                "unexpected error on SCHEMA {era}: {error:#}"
            );
        }

        let conn = read_only_connection(&workspace.db_path);
        assert!(
            !table_exists(&conn, "narrative_application_contributions_v29"),
            "the savepoint must remove the rebuild's scratch table, or every later \
             open fails on CREATE TABLE and the workspace is unopenable (SCHEMA {era})"
        );
        assert!(
            !table_has_column(&conn, "narrative_application_contributions", "commit_id"),
            "the pre-upgrade table must be back, not the half-built one (SCHEMA {era})"
        );
        assert_eq!(
            count(&conn, "narrative_application_contributions"),
            4,
            "no attribution row may be lost to a refused rebuild (SCHEMA {era})"
        );
        assert_eq!(
            consumer_freshness_rows(&conn, UNTOUCHED_RUN_ID),
            1,
            "derived state must survive a refused rebuild too (SCHEMA {era})"
        );
        assert_eq!(user_version(&conn), era);
        drop(conn);

        // Dropping the unusable attribution row is all it takes: the workspace
        // itself was never damaged.
        let db = workspace.open();
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_application_contributions WHERE id = ?1",
                params![BLANK_CONTRIBUTION_ID],
            )?;
            Ok(())
        })
        .expect("drop the unusable Contribution");
        db.migrate()
            .unwrap_or_else(|error| panic!("upgrade a repaired SCHEMA {era} workspace: {error:#}"));
        drop(db);

        let conn = read_only_connection(&workspace.db_path);
        assert_eq!(user_version(&conn), SCHEMA_VERSION);
        assert!(has_current_schema_checkpoint_invariants(&conn).expect("checkpoint"));
        assert!(index_exists(&conn, COMMIT_INDEX));
        assert_eq!(count(&conn, "narrative_application_contributions"), 3);
        assert_eq!(
            contribution_baseline(&conn, HUMAN_OWNED_CONTRIBUTION_ID),
            Some(APPLY_EVENT_SEQUENCE)
        );
    }
}
