//! Gate C2 Lane P (Performance / Adversarial, final Wave 2 lane):
//! cross-Lane adversarial integration coverage for the Semantic Build Graph
//! modules that landed in Wave 1 (Lane A-H) and Wave 2 (Lane I/J/K/L/M/N/O)
//! -- `semantic_epoch`, `execution_state`, `finding_observation`,
//! `attention`, `source_revision`, `evaluator`, `dependency_edges`,
//! `application_contributions`, `cursor_reservation`, `publish_runtime`,
//! `legacy_backfill`, `restore_rebuild`, `inbox_read_model`.
//!
//! # Why this file cannot call any of those modules' functions directly
//!
//! Every one of the 13 modules above is declared as a *private* `mod` in
//! `narrative_extraction/mod.rs` (only `change_feed` is `pub mod`), and
//! every item this Lane needed is re-exported from `mod.rs` as
//! `pub(crate) use ...`, not `pub use ...` -- `mod.rs` says so explicitly:
//!
//! > Gate C2 Wave 1 / Wave 2 (core Rust modules only; no IPC/N-API
//! > entrypoint is wired up yet, so every re-export below is unreachable
//! > from outside its own module's tests until Transport Assembly
//! > (C2-T1/T2) adds a caller).
//!
//! `pub(crate)` is a hard crate boundary in Rust: it is visible anywhere
//! *inside* `grimodex-db` (including every Lane's own `#[cfg(test)] mod
//! tests`, which is how each Lane validated itself in isolation), but a
//! file under `tests/` -- this file included -- compiles as a *separate*
//! crate that only links against `grimodex-db`'s `pub` surface. This is not
//! a theoretical concern: a minimal throwaway crate reproducing the exact
//! shape used here (`pub fn` inside a private `mod`, re-exported via
//! `pub(crate) use`) fails to compile from an external integration test
//! with `error[E0603]: function is private`, confirmed against `rustc
//! 1.94.1` before writing a single test below. `source_revision` (Lane E)
//! is not even re-exported at all -- `mod.rs` declares `mod
//! source_revision;` with no `pub(crate) use` of anything in it, so it is
//! reachable only via `super::source_revision::...` from sibling Lane
//! modules inside the crate.
//!
//! This is a *distinct* blocker from this repo's documented
//! `libsqlite3-sys` `cfg_select` environment issue: even in an environment
//! where `cargo test` runs, a `tests/*.rs` file that calls
//! `narrative_extraction::create_epoch_in_tx` (or any of the other Lane
//! A-O primitives) would fail to compile with a private-item error, not an
//! environment error. Concretely: the task brief for this Lane assumed
//! `pub(crate)` functions are callable from a `tests/*.rs` integration
//! test; they are not, for any Rust crate, ever. **This is this Lane's
//! primary structural finding** and is reported in full in the session's
//! final summary; see also each test's own doc comment below for how it
//! shaped that specific test.
//!
//! # What this file does instead
//!
//! Every test below drives the *real, currently-migrated* SQLite schema
//! (`Database::new` + `db.migrate()`, exactly like every other file in this
//! directory) directly through `rusqlite`, using SQL **hand-copied
//! verbatim** from the Lane source file it stands in for -- every helper
//! below names the exact function and file it replicates, so a reviewer can
//! diff the two side by side. This is a deliberate, disclosed compromise:
//!
//! - It fully, faithfully exercises the **shared schema contract** (CHECK
//!   constraints, foreign keys, primary/unique keys) those 13 Lanes are
//!   physically built on -- which is exactly where a cross-Lane
//!   compatibility bug would first show up as these Lanes evolve
//!   independently, and it is real production code
//!   (`grimodex-db::migrate`, reachable and public).
//! - It does **not** exercise any Lane's own Rust control flow, branching,
//!   or error handling -- each Lane's own `#[cfg(test)] mod tests` (already
//!   extensive, verified while reading every module for this Lane) remains
//!   the authoritative check for that.
//! - Composing several Lanes' hand-copied SQL in one test *did* surface two
//!   concrete, real defects that no single Lane's isolated unit tests could
//!   have caught. Both were fixed by the Integration Owner in production
//!   code after this Lane reported them; the two tests below were updated
//!   in place to regression-test the fixes rather than document the bugs --
//!   see `attempt_check_constraint_rejects_next_attempt_at_with_null_retry_disposition`
//!   (`migrate.rs`'s SCHEMA_VERSION 23 CHECK constraint) and
//!   `publish_runtime_and_inbox_read_model_now_agree_on_finding_key_convention`
//!   (`publish_runtime::edge_finding_key` renamed to `consumer_finding_key`
//!   and re-keyed to match `inbox_read_model`'s convention).

use rusqlite::{params, Connection, OptionalExtension};

use grimodex_db::Database;

// ---------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------

fn migrated_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db
}

fn seed_project(conn: &Connection, project_id: &str) {
    conn.execute(
        "INSERT INTO projects (id, title) VALUES (?1, ?2)",
        params![project_id, "Test Project"],
    )
    .expect("seed project");
}

/// Literal replica of `semantic_epoch::create_epoch_in_tx` (Lane A,
/// `narrative_extraction/semantic_epoch.rs`).
fn seed_epoch(conn: &Connection, id: &str, project_id: &str, reason: &str) {
    let epoch_number: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(epoch_number), -1) + 1
               FROM narrative_semantic_epochs WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .expect("compute next epoch_number");
    conn.execute(
        "INSERT INTO narrative_semantic_epochs
            (id, project_id, epoch_number, reason, triggered_by_change_event_uid, created_at)
         VALUES (?1, ?2, ?3, ?4, NULL, '2026-08-15T00:00:00.000Z')",
        params![id, project_id, epoch_number, reason],
    )
    .expect("insert epoch (Lane A semantic_epoch::create_epoch_in_tx replica)");
}

/// Literal replica of `dependency_edges::record_dependency_edge_in_tx`
/// (Lane G, `narrative_extraction/dependency_edges.rs`), fresh-insert path
/// only (this file never needs the upsert branch).
fn seed_edge(
    conn: &Connection,
    id: &str,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
    source_object_identity: &str,
) {
    conn.execute(
        "INSERT INTO narrative_dependency_edges
            (id, project_id, consumer_kind, consumer_key, source_object_identity, read_set_json,
             generated_by_transaction_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '[\"/body\"]', NULL, '2026-08-15T00:00:00.000Z')",
        params![
            id,
            project_id,
            consumer_kind,
            consumer_key,
            source_object_identity
        ],
    )
    .expect("insert dependency edge (Lane G record_dependency_edge_in_tx replica)");
}

/// Literal replica of the `narrative_extraction_runs` fixture every Lane
/// B/I/J test file in `src/narrative_extraction/*.rs` seeds by hand (there
/// is no typed writer this Lane can call either -- `repository.rs`'s
/// `create_run` still writes raw status literals per Lane B's own module
/// doc, "Nothing in production code calls these items yet").
fn seed_run(conn: &Connection, run_id: &str, project_id: &str, status: &str) {
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, version)
         VALUES (?1, ?2, 'chronicle.extract', '{}', '{}', 'digest-1',
                 ?3, '{}', datetime('now'), 0)",
        params![run_id, project_id, status],
    )
    .expect("insert run");
}

fn seed_task(conn: &Connection, task_id: &str, run_id: &str, status: &str) {
    conn.execute(
        "INSERT INTO narrative_extraction_tasks
            (id, run_id, task_kind, status, input_json, priority, attempt_count,
             created_at, version)
         VALUES (?1, ?2, 'plan_windows', ?3, '{}', 0, 0, datetime('now'), 0)",
        params![task_id, run_id, status],
    )
    .expect("insert task");
}

/// Literal replica of the cursor row `publish_runtime.rs`'s own tests seed
/// (Lane I/J, `narrative_change_cursors`, pre-reservation shape).
fn seed_cursor(conn: &Connection, project_id: &str, consumer_id: &str) {
    conn.execute(
        "INSERT INTO narrative_change_cursors
            (project_id, consumer_id, acknowledged_through_sequence, updated_at)
         VALUES (?1, ?2, 0, '2026-08-15T00:00:00.000Z')",
        params![project_id, consumer_id],
    )
    .expect("insert cursor");
}

/// Literal replica of `publish_runtime::write_edge_state_in_tx` +
/// `write_consumer_freshness_in_tx` + (conditionally)
/// `finding_observation::record_finding_observation_in_tx` +
/// `execution_state::transition_run_status_in_tx` (Run -> Completed) +
/// `cursor_reservation::acknowledge_cursor_in_tx`, issued in the fixed
/// order `publish_runtime::publish_freshness_evaluation_in_tx`'s own doc
/// comment documents (a-e), for exactly one Dependency Edge. `finding_key`
/// is taken as a parameter rather than derived, because this file's own
/// tests need to pass both Lane J's real convention
/// (`edge:{edge_id}`, see `publish_runtime::edge_finding_key`) and Lane
/// O's real convention (`{consumer_kind}:{consumer_key}`, see
/// `inbox_read_model::consumer_finding_key`) through this same helper --
/// see `publish_runtime_finding_key_and_inbox_read_model_finding_key_conventions_do_not_match`
/// below for why that distinction matters.
#[allow(clippy::too_many_arguments)]
fn publish_single_edge_replica(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    consumer_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
    edge_id: &str,
    epoch_id: &str,
    evidence_freshness: &str,
    reason_code: Option<&str>,
    build_action: &str,
    finding_key: &str,
    material_basis_digest: &str,
    through_sequence: i64,
    now: &str,
) {
    // a. narrative_dependency_edge_states (Lane J).
    conn.execute(
        "INSERT INTO narrative_dependency_edge_states
            (edge_id, project_id, evidence_freshness, reason_code, build_action,
             evaluated_at_epoch_id, evaluated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(edge_id) DO UPDATE SET
             evidence_freshness = excluded.evidence_freshness,
             reason_code = excluded.reason_code,
             build_action = excluded.build_action,
             evaluated_at_epoch_id = excluded.evaluated_at_epoch_id,
             evaluated_at = excluded.evaluated_at",
        params![
            edge_id,
            project_id,
            evidence_freshness,
            reason_code,
            build_action,
            epoch_id,
            now
        ],
    )
    .expect("write edge state (Lane J write_edge_state_in_tx replica)");

    // b. narrative_consumer_freshness (Lane J) -- single edge, so it is
    //    trivially "the worst" (freshness_severity_rank's reduction over a
    //    one-element slice needs no comparison).
    conn.execute(
        "INSERT INTO narrative_consumer_freshness
            (project_id, consumer_kind, consumer_key, evidence_freshness, build_action,
             semantic_epoch_id, last_evaluated_run_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(project_id, consumer_kind, consumer_key) DO UPDATE SET
             evidence_freshness = excluded.evidence_freshness,
             build_action = excluded.build_action,
             semantic_epoch_id = excluded.semantic_epoch_id,
             last_evaluated_run_id = excluded.last_evaluated_run_id,
             updated_at = excluded.updated_at",
        params![
            project_id,
            consumer_kind,
            consumer_key,
            evidence_freshness,
            build_action,
            epoch_id,
            run_id,
            now
        ],
    )
    .expect("write consumer freshness (Lane J write_consumer_freshness_in_tx replica)");

    // c. narrative_maintenance_finding_observations (Lane C), only when
    //    there is a reason code -- matching publish_runtime's own "a Fresh
    //    edge with reason_code: None produces no Finding" rule.
    if let Some(reason_code) = reason_code {
        conn.execute(
            "INSERT INTO narrative_maintenance_finding_observations
                (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
                 reason_code, evidence_freshness_snapshot, material_basis_digest, observed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                format!("finding-{edge_id}-{now}"),
                project_id,
                run_id,
                epoch_id,
                edge_id,
                finding_key,
                reason_code,
                evidence_freshness,
                material_basis_digest,
                now,
            ],
        )
        .expect("record finding observation (Lane C record_finding_observation_in_tx replica)");
    }

    // d. Run -> completed (Lane B transition_run_status_in_tx replica,
    //    running -> completed edge only -- the only edge this file needs).
    let updated = conn
        .execute(
            "UPDATE narrative_extraction_runs
                SET status = 'completed',
                    completed_at = ?2,
                    version = version + 1
              WHERE id = ?1 AND status = 'running'",
            params![run_id, now],
        )
        .expect("transition run to completed (Lane B transition_run_status_in_tx replica)");
    assert_eq!(
        updated, 1,
        "fixture bug: run must be 'running' before publish"
    );

    // e. Cursor acknowledge + reservation release (Lane I
    //    acknowledge_cursor_in_tx replica).
    conn.execute(
        "UPDATE narrative_change_cursors
            SET acknowledged_through_sequence = MAX(acknowledged_through_sequence, ?1),
                semantic_epoch_id = NULL,
                reserved_through_sequence = NULL,
                active_run_id = NULL,
                updated_at = ?2
          WHERE project_id = ?3 AND consumer_id = ?4",
        params![through_sequence, now, project_id, consumer_id],
    )
    .expect("acknowledge cursor (Lane I acknowledge_cursor_in_tx replica)");
}

/// Literal replica of `restore_rebuild::rotate_epoch_for_restore_in_tx`
/// (Lane N, `narrative_extraction/restore_rebuild.rs`).
fn rotate_epoch_for_restore_replica(
    conn: &Connection,
    id: &str,
    project_id: &str,
    structural_impact_event: &str,
) -> Option<String> {
    let reason = match structural_impact_event {
        "project-restored" => "restore",
        "semantic-epoch-reset" => "migration",
        _ => return None,
    };
    seed_epoch(conn, id, project_id, reason);
    Some(id.to_string())
}

/// Literal replica of `legacy_backfill::backfill_project_semantic_build_graph_in_tx`
/// (Lane K, `narrative_extraction/legacy_backfill.rs`). Returns
/// `(epoch_created, contributions_created)`, matching `BackfillSummary`'s
/// two fields.
fn backfill_project_replica(conn: &Connection, project_id: &str, now: &str) -> (bool, i64) {
    let has_epoch: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM narrative_semantic_epochs WHERE project_id = ?1)",
            params![project_id],
            |row| row.get(0),
        )
        .expect("check epoch exists");
    let epoch_created = if !has_epoch {
        seed_epoch(
            conn,
            &format!("epoch-backfill-{project_id}"),
            project_id,
            "initial",
        );
        true
    } else {
        false
    };

    let before: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM narrative_application_contributions WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .expect("count contributions before");

    let applications: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT a.id, a.applied_entity_kind, a.applied_entity_id
               FROM narrative_proposal_applications a
               INNER JOIN narrative_apply_commits c ON c.id = a.commit_id
              WHERE c.project_id = ?1
              ORDER BY a.created_at ASC, a.id ASC",
        )
        .expect("prepare legacy application query")
        .query_map(params![project_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .expect("query legacy applications")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect legacy applications");

    for (application_id, applied_entity_kind, applied_entity_id) in applications {
        let target_object_identity = format!("{applied_entity_kind}:{applied_entity_id}");
        conn.execute(
            "INSERT INTO narrative_application_contributions
                (id, project_id, application_id, target_object_identity, field_path,
                 target_state, created_at)
             VALUES (?1, ?2, ?3, ?4, '/legacy-application', 'unchanged', ?5)
             ON CONFLICT(project_id, application_id, target_object_identity, field_path)
             DO UPDATE SET target_state = excluded.target_state, created_at = excluded.created_at",
            params![
                format!("contribution-{application_id}"),
                project_id,
                application_id,
                target_object_identity,
                now
            ],
        )
        .expect("upsert contribution (Lane H record_contribution_in_tx replica)");
    }

    let after: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM narrative_application_contributions WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .expect("count contributions after");

    (epoch_created, after - before)
}

/// Literal replica of `finding_observation::list_observations_for_epoch(..).pop()`,
/// exactly as `inbox_read_model::build_maintenance_inbox` uses it (Lane
/// C + Lane O).
fn latest_observation_material_basis_digest(
    conn: &Connection,
    project_id: &str,
    semantic_epoch_id: &str,
    finding_key: &str,
) -> Option<String> {
    conn.prepare(
        "SELECT material_basis_digest FROM narrative_maintenance_finding_observations
          WHERE project_id = ?1 AND semantic_epoch_id = ?2 AND finding_key = ?3
          ORDER BY observed_at ASC, rowid ASC",
    )
    .expect("prepare observations query")
    .query_map(params![project_id, semantic_epoch_id, finding_key], |row| {
        row.get::<_, String>(0)
    })
    .expect("query observations")
    .collect::<Result<Vec<_>, _>>()
    .expect("collect observations")
    .pop()
}

/// Literal replica of `attention::is_attention_applicable` (Lane D, a pure,
/// no-DB function -- copied here rather than proxied through SQL because
/// the original is trivial enough to transcribe exactly).
fn attention_is_applicable(
    disposition: &str,
    material_basis_digest: &str,
    snoozed_until: Option<&str>,
    current_material_basis_digest: &str,
    now: &str,
) -> bool {
    if material_basis_digest != current_material_basis_digest {
        return false;
    }
    match disposition {
        "snoozed" => snoozed_until.is_some_and(|until| until > now),
        "dismissed" | "flagged" => true,
        _ => false,
    }
}

/// Literal replica of `inbox_read_model::build_maintenance_inbox`'s
/// visibility decision for exactly one Consumer (Lane O). Returns `false`
/// when the Consumer would not appear in the Inbox at all (no current
/// epoch, no Freshness row, or an active unexpired snooze); `true`
/// otherwise. This intentionally mirrors only the *visibility* rule, not
/// every field `InboxEntry` carries -- individual tests below query the
/// specific columns they care about directly.
fn inbox_would_show_consumer(
    conn: &Connection,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
    now: &str,
) -> bool {
    let current_epoch_id: Option<String> = conn
        .query_row(
            "SELECT id FROM narrative_semantic_epochs WHERE project_id = ?1
              ORDER BY epoch_number DESC LIMIT 1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()
        .expect("select current epoch");
    let Some(current_epoch_id) = current_epoch_id else {
        return false;
    };

    let has_freshness_row: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM narrative_consumer_freshness
                 WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3
             )",
            params![project_id, consumer_kind, consumer_key],
            |row| row.get(0),
        )
        .expect("check consumer freshness row exists");
    if !has_freshness_row {
        return false;
    }

    let finding_key = format!("{consumer_kind}:{consumer_key}");
    let latest_digest =
        latest_observation_material_basis_digest(conn, project_id, &current_epoch_id, &finding_key);

    let attention: Option<(String, String, Option<String>)> = conn
        .query_row(
            "SELECT disposition, material_basis_digest, snoozed_until
               FROM narrative_maintenance_attention
              WHERE project_id = ?1 AND finding_key = ?2",
            params![project_id, finding_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .expect("select attention row");

    let is_snoozed_and_active = match &attention {
        Some((disposition, attention_digest, snoozed_until)) if disposition == "snoozed" => {
            let current_digest = latest_digest
                .as_deref()
                .unwrap_or(attention_digest.as_str());
            attention_is_applicable(
                "snoozed",
                attention_digest,
                snoozed_until.as_deref(),
                current_digest,
                now,
            )
        }
        _ => false,
    };

    !is_snoozed_and_active
}

// ---------------------------------------------------------------------
// 1. End-to-end flow: epoch -> edge -> (evaluate_edge, hand-computed) ->
//    publish -> inbox.
// ---------------------------------------------------------------------

/// Scenario 1. `evaluate_edge` (Lane F) is a pure function reachable only
/// inside the crate; the branch used here (token and digest both changed,
/// Read Set still overlaps -> Stale / SourceRevisionChanged /
/// RebuildRequired) is exactly the branch evaluator.rs's own
/// `token_and_digest_changed_with_overlapping_read_set_is_stale` unit test
/// exercises, so its output is taken as a given here rather than
/// recomputed. This test's job is everything *downstream* of that pure
/// decision: does Lane G's Edge, Lane J's Publish writes, and Lane O's read
/// model compose into one consistent picture.
#[test]
fn end_to_end_epoch_to_dependency_edge_to_publish_to_inbox_is_internally_consistent() {
    let db = migrated_db();
    db.with_conn(|conn| {
        seed_project(conn, "project-1");
        seed_epoch(conn, "epoch-1", "project-1", "initial");
        seed_edge(
            conn,
            "edge-1",
            "project-1",
            "proposal",
            "proposal-1",
            "project:scene:scene-1",
        );
        seed_run(conn, "run-1", "project-1", "running");
        seed_cursor(conn, "project-1", "consumer-a");

        publish_single_edge_replica(
            conn,
            "project-1",
            "run-1",
            "consumer-a",
            "proposal",
            "proposal-1",
            "edge-1",
            "epoch-1",
            "stale",
            Some("source-revision-changed"),
            "rebuild-required",
            "edge:edge-1", // Lane J's own key: publish_runtime::edge_finding_key(edge_id)
            "sha256:material-1",
            5,
            "2026-08-15T01:00:00.000Z",
        );

        // Run and Cursor transitioned together with the Freshness publish.
        let run_status: String = conn
            .query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = 'run-1'",
                [],
                |row| row.get(0),
            )
            .expect("run status");
        assert_eq!(run_status, "completed");
        let (acknowledged, active_run): (i64, Option<String>) = conn
            .query_row(
                "SELECT acknowledged_through_sequence, active_run_id FROM narrative_change_cursors
                  WHERE project_id = 'project-1' AND consumer_id = 'consumer-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("cursor state");
        assert_eq!(acknowledged, 5);
        assert_eq!(active_run, None);

        // The Edge's own diagnostic snapshot and the Consumer's rolled-up
        // Freshness authority both reflect the published outcome.
        let edge_freshness: String = conn
            .query_row(
                "SELECT evidence_freshness FROM narrative_dependency_edge_states WHERE edge_id = 'edge-1'",
                [],
                |row| row.get(0),
            )
            .expect("edge state");
        assert_eq!(edge_freshness, "stale");
        let (consumer_freshness, build_action): (String, String) = conn
            .query_row(
                "SELECT evidence_freshness, build_action FROM narrative_consumer_freshness
                  WHERE project_id = 'project-1' AND consumer_kind = 'proposal' AND consumer_key = 'proposal-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("consumer freshness");
        assert_eq!(consumer_freshness, "stale");
        assert_eq!(build_action, "rebuild-required");

        // Lane O's Inbox surfaces the Consumer -- visibility never depends
        // on a Finding Observation being present at all (see Lane O's own
        // `fresh_consumer_without_attention_is_visible_with_no_observation_or_attention`).
        assert!(inbox_would_show_consumer(
            conn,
            "project-1",
            "proposal",
            "proposal-1",
            "2026-08-15T02:00:00.000Z"
        ));

        // The raw Finding Observation genuinely exists, written under Lane
        // J's own key...
        let finding_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_maintenance_finding_observations WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .expect("finding count");
        assert_eq!(finding_count, 1);
        let via_lane_j_key =
            latest_observation_material_basis_digest(conn, "project-1", "epoch-1", "edge:edge-1");
        assert_eq!(via_lane_j_key.as_deref(), Some("sha256:material-1"));

        // ...but see the dedicated test below: Lane O's *own* lookup key
        // for this same Consumer ("proposal:proposal-1") does not match it,
        // so `InboxEntry.latest_observation` would in fact be `None` here.
        let via_lane_o_key = latest_observation_material_basis_digest(
            conn,
            "project-1",
            "epoch-1",
            "proposal:proposal-1",
        );
        assert_eq!(via_lane_o_key, None);
        Ok(())
    })
    .expect("with_conn");
}

/// **Regression test for a cross-Lane integration bug this same adversarial
/// suite originally found and reported** (not one of the 10 scripted
/// scenarios -- discovered while composing Lane J and Lane O for scenario 1
/// above). The first version of this suite found that
/// `publish_runtime::edge_finding_key` (Lane J) minted Finding Observation
/// rows keyed `edge:{edge_id}` (per Dependency Edge) while
/// `inbox_read_model::consumer_finding_key` (Lane O) read them back keyed
/// `{consumer_kind}:{consumer_key}` (per Consumer) -- both Lanes had
/// documented the divergence as "out of scope," but no test had ever run
/// the real Producer -> Mutation -> Publish -> Inbox flow end-to-end, so a
/// Consumer's real diagnostic Finding Observation was silently invisible to
/// the real Inbox.
///
/// The Integration Owner fixed this by renaming
/// `publish_runtime::edge_finding_key` to `consumer_finding_key` and
/// changing it to key on `(consumer_kind, consumer_key)`, matching
/// `inbox_read_model`'s convention (see that function's doc comment for the
/// full rationale: the Inbox is the user-facing, Consumer-grained surface,
/// so Lane J conforms to it rather than the reverse). `edge_id` is still
/// recorded per-row via `narrative_maintenance_finding_observations.edge_id`,
/// so per-Edge attribution is not lost, only de-emphasized as the lookup
/// key. This test replays the same scenario with the corrected key and
/// asserts the Inbox's lookup now finds the row Lane J wrote.
#[test]
fn publish_runtime_and_inbox_read_model_now_agree_on_finding_key_convention() {
    let db = migrated_db();
    db.with_conn(|conn| {
        seed_project(conn, "project-1");
        seed_epoch(conn, "epoch-1", "project-1", "initial");
        seed_edge(
            conn,
            "edge-1",
            "project-1",
            "proposal",
            "proposal-1",
            "project:scene:scene-1",
        );
        seed_run(conn, "run-1", "project-1", "running");
        seed_cursor(conn, "project-1", "consumer-a");

        publish_single_edge_replica(
            conn,
            "project-1",
            "run-1",
            "consumer-a",
            "proposal",
            "proposal-1",
            "edge-1",
            "epoch-1",
            "stale",
            Some("source-revision-changed"),
            "rebuild-required",
            "proposal:proposal-1", // Lane J's (fixed) consumer_finding_key(consumer_kind, consumer_key)
            "sha256:material-1",
            5,
            "2026-08-15T01:00:00.000Z",
        );

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_maintenance_finding_observations WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .expect("count findings");
        assert_eq!(count, 1, "Lane J did record a Finding Observation");

        let edge_id_column: Option<String> = conn
            .query_row(
                "SELECT edge_id FROM narrative_maintenance_finding_observations WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .expect("read edge_id column");
        assert_eq!(
            edge_id_column.as_deref(),
            Some("edge-1"),
            "per-Edge attribution must survive in the edge_id column even though finding_key is now Consumer-grained"
        );

        // Lane O's Consumer-grained lookup key now matches Lane J's
        // (fixed) Consumer-grained key, so the diagnostic detail is
        // visible.
        let inbox_finding_key = "proposal:proposal-1"; // inbox_read_model::consumer_finding_key
        let latest =
            latest_observation_material_basis_digest(conn, "project-1", "epoch-1", inbox_finding_key);
        assert_eq!(
            latest,
            Some("sha256:material-1".to_string()),
            "Lane O's lookup key now matches the Finding Observation Lane J wrote for this Consumer"
        );
        Ok(())
    })
    .expect("with_conn");
}

// ---------------------------------------------------------------------
// 2. Finding Observation tamper resistance.
// ---------------------------------------------------------------------

/// Scenario 2. Directly mutating `evidence_freshness_snapshot` on a Finding
/// Observation row -- the diagnostic-only snapshot, per
/// `narrative-finding-contract.json`'s `freshnessSnapshotPolicy:
/// "diagnostic-only"` -- must never change `narrative_consumer_freshness`
/// (the durable authority, Lane J) or what the Inbox (Lane O) displays for
/// that Consumer. Uses Lane O's own `finding_key` convention throughout
/// (`{consumer_kind}:{consumer_key}`), matching how Lane O's own fixtures
/// seed a Finding Observation, so this test is not itself confounded by the
/// key-mismatch finding above.
#[test]
fn tampering_with_finding_observation_freshness_snapshot_does_not_change_consumer_freshness_or_inbox(
) {
    let db = migrated_db();
    db.with_conn(|conn| {
        seed_project(conn, "project-1");
        seed_epoch(conn, "epoch-1", "project-1", "initial");
        conn.execute(
            "INSERT INTO narrative_consumer_freshness
                (project_id, consumer_kind, consumer_key, evidence_freshness, build_action,
                 semantic_epoch_id, last_evaluated_run_id, updated_at)
             VALUES ('project-1', 'proposal', 'proposal-1', 'stale', 'rebuild-required',
                     'epoch-1', NULL, '2026-08-15T00:00:00.000Z')",
            [],
        )
        .expect("seed consumer freshness");
        let finding_key = "proposal:proposal-1";
        conn.execute(
            "INSERT INTO narrative_maintenance_finding_observations
                (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
                 reason_code, evidence_freshness_snapshot, material_basis_digest, observed_at)
             VALUES ('finding-1', 'project-1', 'run-1', 'epoch-1', NULL, ?1,
                     'source-revision-changed', 'stale', 'sha256:material-1',
                     '2026-08-15T00:00:01.000Z')",
            params![finding_key],
        )
        .expect("seed finding observation");

        // Adversary: an UPDATE that touches only the diagnostic snapshot
        // column, nothing else.
        conn.execute(
            "UPDATE narrative_maintenance_finding_observations
                SET evidence_freshness_snapshot = 'fresh' WHERE id = 'finding-1'",
            [],
        )
        .expect("tamper with finding observation snapshot");

        let consumer_freshness: String = conn
            .query_row(
                "SELECT evidence_freshness FROM narrative_consumer_freshness
                  WHERE project_id = 'project-1' AND consumer_kind = 'proposal' AND consumer_key = 'proposal-1'",
                [],
                |row| row.get(0),
            )
            .expect("consumer freshness after tamper");
        assert_eq!(
            consumer_freshness, "stale",
            "the durable Freshness authority must be untouched by a Finding Observation-only write"
        );

        assert!(inbox_would_show_consumer(
            conn,
            "project-1",
            "proposal",
            "proposal-1",
            "2026-08-15T02:00:00.000Z"
        ));
        // inbox_read_model.rs's own module doc: "nothing else here reads
        // Finding Observation snapshots as a stand-in for current
        // Freshness" -- the Inbox's displayed freshness is read straight
        // off narrative_consumer_freshness, so it is untouched too.
        let inbox_freshness: String = conn
            .query_row(
                "SELECT evidence_freshness FROM narrative_consumer_freshness
                  WHERE project_id = 'project-1' AND consumer_kind = 'proposal' AND consumer_key = 'proposal-1'",
                [],
                |row| row.get(0),
            )
            .expect("inbox-displayed freshness");
        assert_eq!(inbox_freshness, "stale");
        Ok(())
    })
    .expect("with_conn");
}

// ---------------------------------------------------------------------
// 3. Status-axis confusion, physically rejected.
// ---------------------------------------------------------------------

/// Scenario 3. `'queued'` is a Task-only status
/// (`execution_state::NarrativeTaskStatus`); `narrative_extraction_runs`'s
/// CHECK constraint (SCHEMA_VERSION 23,
/// `migrate_narrative_extraction_status_v23`) only allows
/// `('pending','running','completed','failed','cancelled','superseded')`.
/// This bypasses Lane B's Rust-level `NarrativeRunStatus::try_from` guard
/// entirely and hits the physical CHECK constraint directly with raw SQL,
/// as the task brief asked ("Rustのenumバリデーションを迂回した生SQLでも防御されているか
/// の二重確認").
#[test]
fn run_status_check_constraint_rejects_task_only_status_queued() {
    let db = migrated_db();
    db.with_conn(|conn| {
        seed_project(conn, "project-1");
        let error = conn
            .execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, version)
                 VALUES ('run-bad', 'project-1', 'chronicle.extract', '{}', '{}', 'digest-1',
                         'queued', '{}', datetime('now'), 0)",
                [],
            )
            .expect_err("Task-only status 'queued' must be rejected on narrative_extraction_runs");
        assert!(
            error.to_string().contains("CHECK constraint"),
            "unexpected error: {error}"
        );
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_extraction_runs WHERE id = 'run-bad'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 0, "the rejected row must not have been persisted");
        Ok(())
    })
    .expect("with_conn");
}

// ---------------------------------------------------------------------
// 4. Attempt retry metadata: one direction correctly rejected, one
//    direction NOT rejected (a real schema gap).
// ---------------------------------------------------------------------

/// Scenario 4, correct half. `narrative_extraction_attempts`'s CHECK
/// `(next_attempt_at IS NULL) OR (retry_disposition = 'retryable')`
/// correctly rejects a terminal `retry_disposition` paired with a
/// non-NULL `next_attempt_at`: `'terminal' = 'retryable'` is a definite
/// `FALSE`, and `FALSE OR FALSE` is `FALSE`.
#[test]
fn attempt_check_constraint_rejects_next_attempt_at_with_terminal_retry_disposition() {
    let db = migrated_db();
    db.with_conn(|conn| {
        seed_project(conn, "project-1");
        seed_run(conn, "run-1", "project-1", "running");
        seed_task(conn, "task-1", "run-1", "running");
        let error = conn
            .execute(
                "INSERT INTO narrative_extraction_attempts
                    (id, task_id, attempt_number, status, started_at,
                     retry_disposition, next_attempt_at)
                 VALUES ('attempt-bad', 'task-1', 1, 'failed', datetime('now'),
                         'terminal', '2099-01-01T00:00:00.000Z')",
                [],
            )
            .expect_err("a terminal retry_disposition with a set next_attempt_at must be rejected");
        assert!(
            error.to_string().contains("CHECK constraint"),
            "unexpected error: {error}"
        );
        Ok(())
    })
    .expect("with_conn");
}

/// Scenario 4, **regression test for a real schema gap this same
/// adversarial suite originally found**. SQLite's CHECK constraints only
/// reject a definite `FALSE`; a `NULL` result is treated as satisfied
/// (SQLite docs, "CHECK constraints"). The original CHECK,
/// `(next_attempt_at IS NULL) OR (retry_disposition = 'retryable')`,
/// collapsed to `FALSE OR NULL = NULL` when `retry_disposition IS NULL`
/// (SQL three-valued logic: `NULL = anything` is `NULL`, never
/// `TRUE`/`FALSE`) -- which SQLite does not reject, silently allowing an
/// Attempt with `next_attempt_at` set ("scheduled for retry") but
/// `retry_disposition` unset ("no disposition ever recorded"), contradicting
/// every real writer's intent in this crate.
///
/// The Integration Owner fixed this in `migrate.rs`'s SCHEMA_VERSION 23
/// `migrate_narrative_extraction_status_v23` by adding an explicit
/// `retry_disposition IS NOT NULL` guard: `CHECK((next_attempt_at IS NULL)
/// OR (retry_disposition IS NOT NULL AND retry_disposition = 'retryable'))`,
/// which forces the right-hand side to a definite `FALSE` (not `NULL`) when
/// `retry_disposition IS NULL`, so the overall `OR` is `FALSE` and SQLite
/// correctly rejects the row. This test replaces the original bug-documenting
/// test (which asserted `inserted.is_ok()`) with the inverse assertion.
#[test]
fn attempt_check_constraint_rejects_next_attempt_at_with_null_retry_disposition() {
    let db = migrated_db();
    db.with_conn(|conn| {
        seed_project(conn, "project-1");
        seed_run(conn, "run-1", "project-1", "running");
        seed_task(conn, "task-1", "run-1", "running");
        let error = conn
            .execute(
                "INSERT INTO narrative_extraction_attempts
                    (id, task_id, attempt_number, status, started_at,
                     retry_disposition, next_attempt_at)
                 VALUES ('attempt-fixed', 'task-1', 1, 'failed', datetime('now'),
                         NULL, '2099-01-01T00:00:00.000Z')",
                [],
            )
            .expect_err(
                "a NULL retry_disposition with a set next_attempt_at must now be rejected \
                 (fixed CHECK constraint)",
            );
        assert!(
            error.to_string().contains("CHECK constraint"),
            "unexpected error: {error}"
        );
        Ok(())
    })
    .expect("with_conn");
}

// ---------------------------------------------------------------------
// 5. Unknown reasonCode, fail-closed.
// ---------------------------------------------------------------------

/// Scenario 5. `narrative_maintenance_finding_observations.reason_code`'s
/// CHECK constraint enumerates the 11 contract values from
/// `narrative-finding-contract.json`; a value outside that set must be
/// rejected at the SQL layer even when `FindingReasonCode::try_from`'s
/// Rust-level guard (Lane C/F) is bypassed entirely.
#[test]
fn finding_observation_check_constraint_rejects_unknown_reason_code() {
    let db = migrated_db();
    db.with_conn(|conn| {
        seed_project(conn, "project-1");
        seed_epoch(conn, "epoch-1", "project-1", "initial");
        let error = conn
            .execute(
                "INSERT INTO narrative_maintenance_finding_observations
                    (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
                     reason_code, evidence_freshness_snapshot, material_basis_digest, observed_at)
                 VALUES ('finding-bad', 'project-1', 'run-1', 'epoch-1', NULL, 'finding-1',
                         'not-a-contract-reason-code', 'stale', 'sha256:x',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )
            .expect_err("an unrecognized reason_code must be rejected");
        assert!(
            error.to_string().contains("CHECK constraint"),
            "unexpected error: {error}"
        );
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_maintenance_finding_observations WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 0);
        Ok(())
    })
    .expect("with_conn");
}

// ---------------------------------------------------------------------
// 6. TTL-window process-restart reclaim: no WorkspaceLease check, by
//    documented design.
// ---------------------------------------------------------------------

/// Scenario 6. `cursor_reservation::reclaim_stale_reservation_in_tx`'s own
/// doc comment states its contract explicitly: "this function does not
/// itself check that the caller holds a WorkspaceLease -- the caller must
/// already hold one ... before calling this." This test confirms that
/// claim is physically true of the SQL, not just the prose: the literal
/// `UPDATE` (replicated below, verified byte-for-byte against
/// `cursor_reservation.rs`) has zero predicate referencing any
/// workspace-lease table or column, so a reclaim from a `current_owner`
/// string that this fixture never associates with any workspace lease at
/// all still succeeds whenever the five documented row-level conditions
/// match.
///
/// This is **not** reported as a defect -- Lane I's doc comment makes the
/// precondition explicit and the reasoning sound (holding the workspace
/// lease is what makes the row-level match safe to trust). It is flagged
/// per the task brief as a real risk worth carrying forward: this same
/// function's own `#[cfg(test)] mod tests` in `cursor_reservation.rs`
/// (verified while reading it for this Lane) only ever exercises the five
/// row-level conditions: every one of its `reclaim_*` tests calls
/// `reclaim_stale_reservation_in_tx` directly, with no
/// `WorkspaceLease`-acquisition step anywhere in the fixture either. There
/// is currently no automated check anywhere in this crate that a real
/// future caller actually acquires the lease first -- that verification is
/// entirely the caller's responsibility, undefended by this function or
/// its own tests. Once Transport Assembly (C2-T1/T2) wires a real caller,
/// the Integration Owner should confirm that caller acquires the
/// `WorkspaceLease` before invoking this function, since nothing else will
/// catch a missed acquisition.
#[test]
fn reclaim_stale_reservation_never_verifies_workspace_lease_by_design() {
    let db = migrated_db();
    db.with_conn(|conn| {
        seed_project(conn, "project-1");
        seed_epoch(conn, "epoch-1", "project-1", "initial");
        seed_run(conn, "run-1", "project-1", "running");
        conn.execute(
            "INSERT INTO narrative_change_cursors
                (project_id, consumer_id, acknowledged_through_sequence, updated_at,
                 semantic_epoch_id, reserved_through_sequence, active_run_id)
             VALUES ('project-1', 'consumer-a', 0, '2026-08-15T00:00:00.000Z',
                     'epoch-1', 10, 'run-1')",
            [],
        )
        .expect("seed reserved cursor row");

        // "process-hostile" never proves it holds project-1's
        // WorkspaceLease anywhere in this fixture -- there is no
        // workspace-lease table write at all in this test.
        let updated = conn
            .execute(
                "UPDATE narrative_change_cursors
                    SET lease_owner = ?1, lease_expires_at = ?2, updated_at = ?3
                  WHERE project_id = ?4
                    AND consumer_id = ?5
                    AND active_run_id = ?6
                    AND semantic_epoch_id = ?7
                    AND reserved_through_sequence = ?8
                    AND EXISTS (
                      SELECT 1 FROM narrative_extraction_runs
                       WHERE id = ?6 AND project_id = ?4 AND status IN ('pending', 'running')
                    )",
                params![
                    "process-hostile",
                    "2099-01-01T00:00:00.000Z",
                    "2026-08-15T01:00:00.000Z",
                    "project-1",
                    "consumer-a",
                    "run-1",
                    "epoch-1",
                    10
                ],
            )
            .expect("reclaim UPDATE (Lane I reclaim_stale_reservation_in_tx replica)");
        assert_eq!(
            updated, 1,
            "reclaim succeeds even though the caller never proved WorkspaceLease ownership"
        );

        let lease_owner: String = conn
            .query_row(
                "SELECT lease_owner FROM narrative_change_cursors
                  WHERE project_id = 'project-1' AND consumer_id = 'consumer-a'",
                [],
                |row| row.get(0),
            )
            .expect("read lease_owner");
        assert_eq!(lease_owner, "process-hostile");
        Ok(())
    })
    .expect("with_conn");
}

// ---------------------------------------------------------------------
// 7. Old epoch Finding Observation ignored after Lane N's rotation.
// ---------------------------------------------------------------------

/// Scenario 7. Unlike Lane O's own unit test of the same shape (which
/// mints both epochs via the Lane A replica directly), this drives the new
/// epoch specifically through the Lane N replica
/// (`rotate_epoch_for_restore_replica`, standing in for
/// `restore_rebuild::rotate_epoch_for_restore_in_tx`), so the epoch-rotation
/// *trigger* (a `"project-restored"` structural impact event) and the
/// Inbox's epoch-scoped read (Lane O) are both exercised together.
#[test]
fn epoch_rotation_via_lane_n_hides_old_epoch_finding_observation_from_lane_o_inbox() {
    let db = migrated_db();
    db.with_conn(|conn| {
        seed_project(conn, "project-1");
        seed_epoch(conn, "epoch-0", "project-1", "initial");
        let finding_key = "proposal:proposal-1";
        conn.execute(
            "INSERT INTO narrative_maintenance_finding_observations
                (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
                 reason_code, evidence_freshness_snapshot, material_basis_digest, observed_at)
             VALUES ('finding-old', 'project-1', 'run-1', 'epoch-0', NULL, ?1,
                     'source-revision-changed', 'stale', 'sha256:old',
                     '2026-08-01T00:00:00.000Z')",
            params![finding_key],
        )
        .expect("seed old-epoch finding");

        // A restore rotates the epoch (Lane N).
        let epoch_1 =
            rotate_epoch_for_restore_replica(conn, "epoch-1", "project-1", "project-restored")
                .expect("project-restored must mint a new epoch");

        // Consumer Freshness now points at the new epoch, as Lane J would
        // write after a post-restore re-evaluation.
        conn.execute(
            "INSERT INTO narrative_consumer_freshness
                (project_id, consumer_kind, consumer_key, evidence_freshness, build_action,
                 semantic_epoch_id, last_evaluated_run_id, updated_at)
             VALUES ('project-1', 'proposal', 'proposal-1', 'unknown', 'resolve-only', ?1,
                     NULL, '2026-08-15T00:00:00.000Z')",
            params![epoch_1],
        )
        .expect("seed post-restore consumer freshness");

        assert!(inbox_would_show_consumer(
            conn,
            "project-1",
            "proposal",
            "proposal-1",
            "2026-08-15T01:00:00.000Z"
        ));
        let latest =
            latest_observation_material_basis_digest(conn, "project-1", &epoch_1, finding_key);
        assert_eq!(
            latest, None,
            "the old epoch's Finding Observation must not surface after Lane N's rotation"
        );
        Ok(())
    })
    .expect("with_conn");
}

// ---------------------------------------------------------------------
// 8. Expired snooze resurfaces.
// ---------------------------------------------------------------------

/// Scenario 8.
#[test]
fn expired_snooze_resurfaces_consumer_in_inbox() {
    let db = migrated_db();
    db.with_conn(|conn| {
        seed_project(conn, "project-1");
        seed_epoch(conn, "epoch-1", "project-1", "initial");
        conn.execute(
            "INSERT INTO narrative_consumer_freshness
                (project_id, consumer_kind, consumer_key, evidence_freshness, build_action,
                 semantic_epoch_id, last_evaluated_run_id, updated_at)
             VALUES ('project-1', 'proposal', 'proposal-1', 'stale', 'rebuild-required',
                     'epoch-1', NULL, '2026-08-15T00:00:00.000Z')",
            [],
        )
        .expect("seed freshness");
        let finding_key = "proposal:proposal-1";
        conn.execute(
            "INSERT INTO narrative_maintenance_finding_observations
                (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
                 reason_code, evidence_freshness_snapshot, material_basis_digest, observed_at)
             VALUES ('finding-1', 'project-1', 'run-1', 'epoch-1', NULL, ?1,
                     'source-revision-changed', 'stale', 'sha256:digest-a',
                     '2026-08-15T00:00:01.000Z')",
            params![finding_key],
        )
        .expect("seed finding");
        // Snooze it (Lane D set_attention_in_tx replica; SCHEMA 25 shape --
        // actor_id/request_id/payload_digest/version replaced set_by).
        conn.execute(
            "INSERT INTO narrative_maintenance_attention
                (project_id, finding_key, disposition, material_basis_digest, snoozed_until,
                 set_at, actor_id, request_id, payload_digest, reason, version)
             VALUES ('project-1', ?1, 'snoozed', 'sha256:digest-a', '2026-09-01T00:00:00.000Z',
                     '2026-08-15T00:30:00.000Z', 'user-1', 'req-adversarial-1',
                     'sha256:payload-a', NULL, 1)",
            params![finding_key],
        )
        .expect("seed attention");

        assert!(
            !inbox_would_show_consumer(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "2026-08-15T01:00:00.000Z"
            ),
            "an active, unexpired snooze must hide the consumer"
        );

        // Time passes the original snoozed_until.
        conn.execute(
            "UPDATE narrative_maintenance_attention SET snoozed_until = '2026-08-01T00:00:00.000Z'
              WHERE project_id = 'project-1' AND finding_key = ?1",
            params![finding_key],
        )
        .expect("expire snooze");

        assert!(
            inbox_would_show_consumer(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "2026-08-15T02:00:00.000Z"
            ),
            "an expired snooze must resurface the consumer"
        );

        // The Attention row itself is retained, unmutated by anything
        // other than the explicit UPDATE this test performed above --
        // matching `attention.rs`'s "reads never mutate" contract.
        let disposition: String = conn
            .query_row(
                "SELECT disposition FROM narrative_maintenance_attention
                  WHERE project_id = 'project-1' AND finding_key = ?1",
                params![finding_key],
                |row| row.get(0),
            )
            .expect("attention row retained");
        assert_eq!(disposition, "snoozed");
        Ok(())
    })
    .expect("with_conn");
}

// ---------------------------------------------------------------------
// 9. Legacy Backfill idempotency, then Publish, without conflict.
// ---------------------------------------------------------------------

/// Scenario 9.
#[test]
fn legacy_backfill_is_idempotent_and_coexists_with_a_subsequent_publish() {
    let db = migrated_db();
    db.with_conn(|conn| {
        seed_project(conn, "project-1");
        // Pre-Gate-C2 Application history, copied verbatim from
        // legacy_backfill.rs's own `seed_legacy_application` test fixture.
        conn.execute(
            "INSERT INTO narrative_apply_commits
                (id, project_id, request_id, plan_digest, status, created_at, version)
             VALUES ('commit-1', 'project-1', 'request-1', 'digest-1', 'applied',
                     '2026-08-01T00:00:00.000Z', 0)",
            [],
        )
        .expect("seed commit");
        conn.execute(
            "INSERT INTO narrative_proposal_applications
                (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                 applied_entity_id, created_at)
             VALUES ('app-1', 'commit-1', 'proposal-1', 'revision-1', 'codex_entry', 'entry-1',
                     '2026-08-01T00:00:00.000Z')",
            [],
        )
        .expect("seed application");

        let (epoch_created_1, contributions_1) =
            backfill_project_replica(conn, "project-1", "2026-08-15T00:00:00.000Z");
        assert!(epoch_created_1);
        assert_eq!(contributions_1, 1);

        // Re-run: idempotent (Lane K's own guarantee).
        let (epoch_created_2, contributions_2) =
            backfill_project_replica(conn, "project-1", "2026-08-15T01:00:00.000Z");
        assert!(!epoch_created_2, "epoch must not be re-minted");
        assert_eq!(contributions_2, 0, "re-run must not create duplicate rows");

        let epoch_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .expect("epoch count");
        assert_eq!(epoch_count, 1);
        let contribution_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_application_contributions WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .expect("contribution count");
        assert_eq!(contribution_count, 1);

        // Lane J now publishes a Freshness evaluation for an unrelated
        // Consumer in the same project, reusing the epoch Lane K minted.
        let epoch_id: String = conn
            .query_row(
                "SELECT id FROM narrative_semantic_epochs WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .expect("epoch id");
        seed_edge(
            conn,
            "edge-1",
            "project-1",
            "proposal",
            "proposal-2",
            "project:scene:scene-1",
        );
        seed_run(conn, "run-1", "project-1", "running");
        seed_cursor(conn, "project-1", "consumer-a");
        publish_single_edge_replica(
            conn,
            "project-1",
            "run-1",
            "consumer-a",
            "proposal",
            "proposal-2",
            "edge-1",
            &epoch_id,
            "fresh",
            None,
            "none",
            "edge:edge-1",
            "sha256:x",
            1,
            "2026-08-15T02:00:00.000Z",
        );

        // No CHECK/UNIQUE violation occurred (every `.expect()` inside the
        // two replicas above would have panicked this test otherwise).
        // Row counts stayed exactly as expected: still one epoch, one
        // legacy Contribution row, and now exactly one Dependency Edge /
        // Consumer Freshness row from the unrelated Publish -- Lane K's and
        // Lane J's writes did not collide.
        let epoch_count_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .expect("epoch count after");
        assert_eq!(epoch_count_after, 1);
        let freshness_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_consumer_freshness WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .expect("freshness count");
        assert_eq!(freshness_count, 1);
        let contribution_count_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_application_contributions WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .expect("contribution count after");
        assert_eq!(
            contribution_count_after, 1,
            "publish must not touch Lane K's contribution rows"
        );
        Ok(())
    })
    .expect("with_conn");
}

// ---------------------------------------------------------------------
// 10. Lazy-load contract for a large Source body.
// ---------------------------------------------------------------------

/// Scenario 10. Literal replica of the two SQL projections
/// `source_revision.rs` (Lane E) issues for `"scene-body"`:
/// `resolve_scene_body` (inside `resolve_current_source_state`'s call
/// chain) selects only `version, updated_at`; `load_scene_canonical_text`
/// (inside `load_canonical_text_for_revalidation`) is the only one of the
/// two that selects `content`. This proves the lazy-load contract at the
/// SQL projection level: the "cheap" query's column list structurally
/// cannot return the body regardless of its size, and only the "expensive"
/// query, called explicitly, does. This is a stronger, SQL-level version of
/// the same claim Lane E's own
/// `current_source_state_is_exhaustively_destructurable_with_no_canonical_text_field`
/// unit test proves at the Rust type level (unreachable here, see file doc
/// comment) and
/// `resolve_current_source_state_for_large_scene_body_never_grows_with_body_length`
/// proves at the timing/size level.
#[test]
fn resolve_current_source_state_sql_excludes_body_while_explicit_load_returns_it() {
    let db = migrated_db();
    db.with_conn(|conn| {
        seed_project(conn, "project-1");
        let big_text = "A".repeat(50_000);
        let doc = format!(
            r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"{big_text}"}}]}}]}}"#
        );
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
             VALUES ('scene-1', 'project-1', 'scene', 'Scene', ?1)",
            params![doc],
        )
        .expect("seed a scene with a ~50,000 char body");

        // Cheap path: source_revision::resolve_scene_body's SELECT. Note
        // the projection never names `content`.
        let (version, updated_at): (i64, String) = conn
            .query_row(
                "SELECT version, updated_at FROM tree_nodes
                  WHERE id = 'scene-1' AND project_id = 'project-1' AND node_type = 'scene'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("resolve_current_source_state SQL replica (Lane E)");
        assert_eq!(version, 0);
        let revision_token = format!("v{version}@{updated_at}");
        assert!(
            revision_token.len() < 128,
            "the cheap state must stay small regardless of a ~50,000 char body, got {} bytes",
            revision_token.len()
        );

        // Expensive path, only when explicitly invoked:
        // source_revision::load_scene_canonical_text's SELECT does name
        // `content` and does return the full body.
        let content: String = conn
            .query_row(
                "SELECT content FROM tree_nodes
                  WHERE id = 'scene-1' AND project_id = 'project-1' AND node_type = 'scene'",
                [],
                |row| row.get(0),
            )
            .expect("load_canonical_text_for_revalidation SQL replica (Lane E)");
        assert!(
            content.len() > 50_000,
            "the explicit body load must return the full content, got {} bytes",
            content.len()
        );
        Ok(())
    })
    .expect("with_conn");
}
