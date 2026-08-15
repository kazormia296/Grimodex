//! Gate C2 Lane N -- Restore/Rebuild: Semantic Epoch rotation on
//! restore/migration, and read-only + repair diagnostics for the Dependency
//! Edge graph a full rebuild needs to reconcile.
//!
//! This module composes three earlier Lanes without modifying any of them:
//! Lane A's Semantic Epoch ledger (`semantic_epoch.rs`), Lane G's Dependency
//! Edge storage (`dependency_edges.rs`), and Lane E's Source revision
//! resolver (`source_revision.rs`).

use rusqlite::{params_from_iter, Connection};

use super::dependency_edges::{find_edges_by_consumer, DependencyEdge};
use super::semantic_epoch::create_epoch_in_tx;
use super::source_revision::resolve_current_source_state;

fn require_non_empty(value: &str, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!value.trim().is_empty(), "{name} is required");
    Ok(())
}

// ---------------------------------------------------------------------
// 1. Epoch rotation trigger
// ---------------------------------------------------------------------

/// Recognized `structuralImpact.event` values that mark a Semantic Epoch
/// reset, and the Semantic Epoch `reason` (Lane A's closed five-value
/// vocabulary, `semantic_epoch::VALID_REASONS`) each one maps to when this
/// Lane mints the new Epoch.
///
/// This is the same pair of trigger values `change_feed.rs`'s
/// `ensure_event_history_continuity` recognizes via its private
/// `is_epoch_reset` local (see that function's doc comment: a Change Feed
/// event whose `object_key.kind == "project"` and whose
/// `structuralImpact.event` is `"project-restored"` or
/// `"semantic-epoch-reset"` starts a new Semantic Epoch and is exempt from
/// that function's normal before/after continuity check). `change_feed.rs`
/// only needs a boolean out of that check (was this event an epoch reset, at
/// all), so it never decides *which* Semantic Epoch `reason` a reset maps
/// to. This Lane does need that mapping -- it is the caller that actually
/// mints the Epoch row Lane A's ledger stores -- so the two recognized
/// values are reimplemented here as a `match` with an explicit `reason` arm
/// each, rather than importing a shared boolean helper. Per this Lane's
/// task brief, `change_feed.rs` itself is read-only background and is not
/// touched or refactored to expose the check; duplicating the two literal
/// values here is the accepted tradeoff.
///
/// Any other `structural_impact_event` value (including one that is not a
/// recognized `structuralImpact.event` at all) rotates nothing and returns
/// `Ok(None)` -- this function is deliberately narrow and never guesses at
/// an Epoch reset the way `change_feed.rs`'s own check does not either.
pub(crate) fn rotate_epoch_for_restore_in_tx(
    conn: &Connection,
    project_id: &str,
    structural_impact_event: &str,
    triggered_by_change_event_uid: Option<&str>,
) -> anyhow::Result<Option<String>> {
    require_non_empty(project_id, "projectId")?;
    let reason = match structural_impact_event {
        "project-restored" => "restore",
        "semantic-epoch-reset" => "migration",
        _ => return Ok(None),
    };
    let epoch_id = create_epoch_in_tx(conn, project_id, reason, triggered_by_change_event_uid)?;
    Ok(Some(epoch_id))
}

// ---------------------------------------------------------------------
// 2. Rebuild verify diagnostics (read-only)
// ---------------------------------------------------------------------

/// The Dependency Edge Consumer identity a full Rebuild Run's own declared
/// Edges are stored under: `consumer_kind = RUN_CONSUMER_KIND`,
/// `consumer_key = run_id`. Lane G's `narrative_dependency_edges` table has
/// no separate `run_id` column -- only `(consumer_kind, consumer_key)`
/// identify a Consumer -- so a Run-scoped diagnostic needs a fixed
/// `consumer_kind` convention to look its own Edges up through
/// `find_edges_by_consumer` the same way any other Consumer would. Wiring an
/// actual Producer to declare Edges under this identity is out of scope for
/// this Lane (no IPC/N-API entrypoint exists yet, same status as every other
/// Gate C2 Wave 2 Lane); this constant only fixes the lookup key so
/// `rebuild_verify_dependency_edges` has a stable convention to query.
const RUN_CONSUMER_KIND: &str = "narrative-extraction-run";

/// Read-only diagnostic report: how many of a Run's declared Dependency
/// Edges point at a Source that no longer resolves. Never written to a
/// table -- callers that want this persisted (e.g. as a Finding Observation,
/// Lane C) own that decision separately.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RebuildVerifyReport {
    pub total_edges: usize,
    pub missing_sources: usize,
    pub edge_ids_with_missing_source: Vec<String>,
}

/// Maps a Dependency Edge's `source_object_identity` to the `source_kind`
/// string `source_revision::resolve_source_revision`'s `match` dispatches
/// on, by testing the same literal prefixes that module's resolvers strip
/// (`resolve_scene_body`, `resolve_snapshot_document`, ...). This mapping
/// must stay in lockstep with those prefixes; `source_revision.rs` is
/// read-only for this Lane so the mapping is reimplemented here rather than
/// exposed from that module. An identity matching none of the recognized
/// prefixes returns `None` -- `rebuild_verify_dependency_edges` treats that
/// the same as a missing Source (see its doc comment) rather than silently
/// skipping the Edge.
fn infer_source_kind(source_object_identity: &str) -> Option<&'static str> {
    if source_object_identity.starts_with("project:scene:") {
        Some("scene-body")
    } else if source_object_identity.starts_with("snapshot:") {
        Some("snapshot-document")
    } else if source_object_identity.starts_with("project:codex-catalog:") {
        Some("codex-catalog")
    } else if source_object_identity.starts_with("projection:") {
        Some("domain-projection")
    } else if source_object_identity.starts_with("artifact:") {
        Some("narrative-artifact")
    } else if source_object_identity.starts_with("capture:") {
        Some("import-capture")
    } else if source_object_identity.starts_with("evidence:") {
        Some("evidence-anchor")
    } else {
        None
    }
}

/// `true` when `edge`'s Source is broken: either its `source_object_identity`
/// does not match any recognized `source_kind` prefix (see
/// `infer_source_kind`), or `resolve_current_source_state` reports it does
/// not currently exist, or resolving it errors at all (a malformed key, a
/// project-scope mismatch, an unsealed/non-current source, ...). Every one
/// of those outcomes means this diagnostic cannot certify the Edge's Source
/// is healthy, so -- matching this crate's fail-closed convention elsewhere
/// (`semantic_epoch::create_epoch_in_tx` on an unrecognized `reason`,
/// `change_feed`'s continuity check on a lineage mismatch) -- it is counted
/// as broken rather than silently skipped or allowed to abort the whole
/// report over one bad Edge.
fn edge_source_is_missing(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    edge: &DependencyEdge,
) -> bool {
    let Some(source_kind) = infer_source_kind(&edge.source_object_identity) else {
        return true;
    };
    match resolve_current_source_state(
        conn,
        project_id,
        run_id,
        source_kind,
        &edge.source_object_identity,
    ) {
        Ok(state) => !state.exists,
        Err(_) => true,
    }
}

/// Read-only diagnostic: for every Dependency Edge Run `run_id` declared
/// (Lane G, looked up via `find_edges_by_consumer` under the
/// [`RUN_CONSUMER_KIND`] convention), resolves the Edge's Source's current
/// state (Lane E, `source_revision::resolve_current_source_state`) and
/// counts how many no longer resolve. Writes nothing -- this function issues
/// only `SELECT`s (through `find_edges_by_consumer` and
/// `resolve_current_source_state`, neither of which mutate) and is safe to
/// call outside a transaction.
pub(crate) fn rebuild_verify_dependency_edges(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<RebuildVerifyReport> {
    require_non_empty(project_id, "projectId")?;
    require_non_empty(run_id, "runId")?;

    let edges = find_edges_by_consumer(conn, project_id, RUN_CONSUMER_KIND, run_id)?;
    let mut edge_ids_with_missing_source = Vec::new();
    for edge in &edges {
        if edge_source_is_missing(conn, project_id, run_id, edge) {
            edge_ids_with_missing_source.push(edge.id.clone());
        }
    }
    Ok(RebuildVerifyReport {
        total_edges: edges.len(),
        missing_sources: edge_ids_with_missing_source.len(),
        edge_ids_with_missing_source,
    })
}

// ---------------------------------------------------------------------
// 3. Rebuild repair
// ---------------------------------------------------------------------

/// Deletes exactly the Dependency Edges named in `edge_ids` (typically the
/// `edge_ids_with_missing_source` a prior `rebuild_verify_dependency_edges`
/// call reported), scoped to `project_id`. Lane G's
/// `delete_edges_for_consumer_in_tx` clears an entire Consumer's Edge set at
/// once and has no per-Edge-id variant, which does not fit a repair step
/// that wants to remove only the specific broken Edges a diagnostic named
/// (a Consumer may also have other, healthy Edges this repair must leave
/// alone) -- so this issues a direct `DELETE ... WHERE project_id = ?1 AND
/// id IN (...)` instead of reusing that function. The `project_id` predicate
/// is what keeps this repair from ever touching another project's Edge even
/// if (implausibly, since ids are UUIDs) an id were to collide.
///
/// Ambient-transaction helper, matching `dependency_edges.rs`'s and
/// `semantic_epoch.rs`'s own `_in_tx` functions in this crate: no
/// `BEGIN`/`COMMIT` of its own, the caller owns the surrounding transaction.
///
/// `edge_ids` empty is a no-op that returns `Ok(0)` without issuing SQL.
/// Returns the number of rows actually deleted.
pub(crate) fn rebuild_repair_dependency_edges_in_tx(
    conn: &Connection,
    project_id: &str,
    edge_ids: &[String],
) -> anyhow::Result<usize> {
    require_non_empty(project_id, "projectId")?;
    if edge_ids.is_empty() {
        return Ok(0);
    }

    // `?1` is `project_id`; the edge id placeholders start at `?2`, matching
    // the numbered-placeholder convention this crate's other dynamic-length
    // `IN (...)` builders use (see `project_snapshots.rs`'s insert-column
    // placeholder builder).
    let placeholders = (0..edge_ids.len())
        .map(|index| format!("?{}", index + 2))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "DELETE FROM narrative_dependency_edges WHERE project_id = ?1 AND id IN ({placeholders})"
    );
    let mut bound_params = Vec::with_capacity(edge_ids.len() + 1);
    bound_params.push(project_id.to_string());
    bound_params.extend(edge_ids.iter().cloned());

    let deleted = conn.execute(&sql, params_from_iter(bound_params.iter()))?;
    Ok(deleted)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::narrative_extraction::{
        get_current_epoch, list_epochs, record_dependency_edge_in_tx,
    };
    use crate::Database;
    use std::path::Path;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-2', 'Project Two')",
                [],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
                 VALUES ('scene-live', 'project-1', 'scene', 'Scene', '{\"type\":\"doc\",\"content\":[]}')",
                [],
            )?;
            Ok(())
        })
        .expect("seed projects and a live scene");
        db
    }

    // -- rotate_epoch_for_restore_in_tx -----------------------------------

    #[test]
    fn project_restored_mints_an_epoch_with_reason_restore() {
        let db = test_db();
        let epoch_id = db
            .with_conn(|conn| {
                rotate_epoch_for_restore_in_tx(
                    conn,
                    "project-1",
                    "project-restored",
                    Some("change-event-1"),
                )
            })
            .expect("rotate on project-restored")
            .expect("project-restored must mint an epoch");

        let current = db
            .with_conn(|conn| get_current_epoch(conn, "project-1"))
            .expect("load current epoch")
            .expect("epoch must exist");
        assert_eq!(current.id, epoch_id);
        assert_eq!(current.epoch_number, 0);
        assert_eq!(current.reason, "restore");
    }

    #[test]
    fn semantic_epoch_reset_mints_an_epoch_with_reason_migration() {
        let db = test_db();
        let epoch_id = db
            .with_conn(|conn| {
                rotate_epoch_for_restore_in_tx(conn, "project-1", "semantic-epoch-reset", None)
            })
            .expect("rotate on semantic-epoch-reset")
            .expect("semantic-epoch-reset must mint an epoch");

        let current = db
            .with_conn(|conn| get_current_epoch(conn, "project-1"))
            .expect("load current epoch")
            .expect("epoch must exist");
        assert_eq!(current.id, epoch_id);
        assert_eq!(current.reason, "migration");
    }

    #[test]
    fn unrecognized_structural_impact_event_rotates_nothing() {
        let db = test_db();
        let result = db
            .with_conn(|conn| {
                rotate_epoch_for_restore_in_tx(conn, "project-1", "schema-component-changed", None)
            })
            .expect("call must not error");
        assert_eq!(result, None);

        let all = db
            .with_conn(|conn| list_epochs(conn, "project-1"))
            .expect("list epochs");
        assert!(
            all.is_empty(),
            "an unrecognized structuralImpact.event must not mint an epoch"
        );
    }

    #[test]
    fn two_restores_advance_the_epoch_number_and_keep_it_current() {
        let db = test_db();
        db.with_conn(|conn| {
            rotate_epoch_for_restore_in_tx(conn, "project-1", "project-restored", None)
        })
        .expect("first restore")
        .expect("first restore must mint an epoch");
        let second_id = db
            .with_conn(|conn| {
                rotate_epoch_for_restore_in_tx(conn, "project-1", "semantic-epoch-reset", None)
            })
            .expect("second restore")
            .expect("second restore must mint an epoch");

        let current = db
            .with_conn(|conn| get_current_epoch(conn, "project-1"))
            .expect("load current epoch")
            .expect("epoch must exist");
        assert_eq!(current.id, second_id);
        assert_eq!(current.epoch_number, 1);
        assert_eq!(current.reason, "migration");

        let all = db
            .with_conn(|conn| list_epochs(conn, "project-1"))
            .expect("list epochs");
        assert_eq!(all.len(), 2);
    }

    // -- rebuild_verify_dependency_edges -----------------------------------

    fn seed_run_edge(
        db: &Database,
        project_id: &str,
        run_id: &str,
        source_object_identity: &str,
    ) -> String {
        db.with_conn(|conn| {
            record_dependency_edge_in_tx(
                conn,
                project_id,
                RUN_CONSUMER_KIND,
                run_id,
                source_object_identity,
                r#"["/body"]"#,
                None,
                "2026-08-15T00:00:00.000Z",
            )
        })
        .expect("record run-scoped edge")
    }

    #[test]
    fn verify_reports_no_missing_sources_when_every_edge_resolves() {
        let db = test_db();
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");

        let report = db
            .with_conn(|conn| rebuild_verify_dependency_edges(conn, "project-1", "run-1"))
            .expect("verify run edges");
        assert_eq!(
            report,
            RebuildVerifyReport {
                total_edges: 1,
                missing_sources: 0,
                edge_ids_with_missing_source: Vec::new(),
            }
        );
    }

    #[test]
    fn verify_detects_a_deleted_scene_source_as_missing() {
        let db = test_db();
        let healthy_id = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let missing_id = seed_run_edge(
            &db,
            "project-1",
            "run-1",
            "project:scene:scene-does-not-exist",
        );

        let report = db
            .with_conn(|conn| rebuild_verify_dependency_edges(conn, "project-1", "run-1"))
            .expect("verify run edges");
        assert_eq!(report.total_edges, 2);
        assert_eq!(report.missing_sources, 1);
        assert_eq!(report.edge_ids_with_missing_source, vec![missing_id]);
        assert!(!report.edge_ids_with_missing_source.contains(&healthy_id));
    }

    #[test]
    fn verify_treats_an_unrecognized_source_identity_shape_as_missing() {
        let db = test_db();
        let unrecognized_id = seed_run_edge(&db, "project-1", "run-1", "totally:unknown:identity");

        let report = db
            .with_conn(|conn| rebuild_verify_dependency_edges(conn, "project-1", "run-1"))
            .expect("verify run edges");
        assert_eq!(report.total_edges, 1);
        assert_eq!(report.missing_sources, 1);
        assert_eq!(report.edge_ids_with_missing_source, vec![unrecognized_id]);
    }

    #[test]
    fn verify_is_scoped_to_the_named_run_and_project() {
        let db = test_db();
        seed_run_edge(
            &db,
            "project-1",
            "run-1",
            "project:scene:scene-does-not-exist",
        );
        // A different run in the same project must not be counted.
        seed_run_edge(
            &db,
            "project-1",
            "run-2",
            "project:scene:scene-does-not-exist",
        );

        let report = db
            .with_conn(|conn| rebuild_verify_dependency_edges(conn, "project-1", "run-2"))
            .expect("verify run-2 edges only");
        assert_eq!(report.total_edges, 1);
    }

    // -- rebuild_repair_dependency_edges_in_tx ------------------------------

    #[test]
    fn repair_deletes_only_the_named_edges() {
        let db = test_db();
        let keep_id = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let broken_id = seed_run_edge(
            &db,
            "project-1",
            "run-1",
            "project:scene:scene-does-not-exist",
        );

        let deleted = db
            .with_conn(|conn| {
                rebuild_repair_dependency_edges_in_tx(conn, "project-1", &[broken_id.clone()])
            })
            .expect("repair broken edge");
        assert_eq!(deleted, 1);

        let remaining = db
            .with_conn(|conn| find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1"))
            .expect("list remaining edges");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, keep_id);
    }

    #[test]
    fn repair_does_not_touch_another_projects_edges() {
        let db = test_db();
        let project_1_edge = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let project_2_edge = seed_run_edge(&db, "project-2", "run-1", "project:scene:scene-live");

        // Ask to delete project-1's edge id, but scope the repair to
        // project-2: the id exists, but not under that project, so nothing
        // is deleted.
        let deleted = db
            .with_conn(|conn| {
                rebuild_repair_dependency_edges_in_tx(conn, "project-2", &[project_1_edge.clone()])
            })
            .expect("repair scoped to project-2");
        assert_eq!(deleted, 0);

        let project_1_remaining = db
            .with_conn(|conn| find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1"))
            .expect("list project-1 edges");
        assert_eq!(project_1_remaining.len(), 1);
        assert_eq!(project_1_remaining[0].id, project_1_edge);

        let project_2_remaining = db
            .with_conn(|conn| find_edges_by_consumer(conn, "project-2", RUN_CONSUMER_KIND, "run-1"))
            .expect("list project-2 edges");
        assert_eq!(project_2_remaining.len(), 1);
        assert_eq!(project_2_remaining[0].id, project_2_edge);
    }

    #[test]
    fn repair_with_empty_edge_ids_is_a_no_op() {
        let db = test_db();
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");

        let deleted = db
            .with_conn(|conn| rebuild_repair_dependency_edges_in_tx(conn, "project-1", &[]))
            .expect("no-op repair");
        assert_eq!(deleted, 0);

        let remaining = db
            .with_conn(|conn| find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1"))
            .expect("list edges");
        assert_eq!(remaining.len(), 1);
    }
}
