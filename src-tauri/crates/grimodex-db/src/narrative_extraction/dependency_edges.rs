//! Generic Dependency Edge persistence and Reverse Dependency Lookup.
//!
//! ADR 005 Amendment (Gate C1.5 Semantic Contract Ratification) fixes the
//! Producer/Mutation contract this module implements:
//!
//! ```text
//! Producer-time
//!   Artifact / Proposal / Application generation
//!     -> Dependency Declaration in the same transaction
//!
//! Mutation-time
//!   Source mutation
//!     -> Change Feed
//!     -> Reverse Dependency Lookup
//!     -> Freshness re-evaluation
//! ```
//!
//! `record_dependency_edge_in_tx` and `delete_edges_for_consumer_in_tx` are
//! ambient-transaction helpers: like `record_human_field_write` and
//! `propagate_source_change_freshness_in_tx` in `field_authority.rs`, they do
//! not open or close a transaction themselves — the caller (an existing
//! Producer-time commit path) is expected to invoke them inside its own
//! `BEGIN IMMEDIATE` / commit block. Wiring those call sites is out of scope
//! for this Lane; see Gate C2-T1.
//!
//! C2-T1 wires the Producer side in: `repository.rs`'s `insert_proposal_seed`
//! and `append_revision_on_conn` call [`record_dependency_edge_in_tx`] for
//! every `SourceBasisRow` a Proposal's Reconciliation Envelope carries,
//! keyed under [`RUN_CONSUMER_KIND`]/the owning Run's id -- the same
//! Consumer identity `restore_rebuild.rs`'s Lane N diagnostics already
//! queried by convention before any Producer declared Edges under it.
//! Edges accumulate per Run across every Proposal/Revision it produces
//! (an upsert per Source, never a delete-then-redeclare at this
//! granularity): deleting a Run's whole Edge set on one Proposal's revision
//! would erase sibling Proposals' Edges from the same Run. When a Run's
//! Edge set as a whole should be cleared (a full re-run/redo) is a
//! separate, not-yet-wired question left to Run/Task/Attempt lifecycle
//! code (Lane B, `execution_state.rs`).

use rusqlite::{params, Connection, Row};

use super::consumer_identity::validate_consumer_identity;
use super::semantic_index_diagnostics::compute_dependency_set_digest;

/// The Dependency Edge Consumer identity a Run's own declared Edges are
/// stored under: `consumer_kind = RUN_CONSUMER_KIND`, `consumer_key =
/// run_id`. `narrative_dependency_edges` has no separate `run_id` column --
/// only `(consumer_kind, consumer_key)` identify a Consumer -- so every
/// Run-scoped caller (Producer-time recording in `repository.rs`,
/// Rebuild-time lookup in `restore_rebuild.rs`) shares this one constant
/// rather than each fixing its own literal.
///
/// Defined in `consumer_identity.rs` (Gate C2-2 moved the whole Consumer
/// vocabulary there) and re-exported here so the call sites that already
/// import it from this module keep working.
pub(crate) use super::consumer_identity::RUN_CONSUMER_KIND;

/// Builds a `source_object_identity` string from a Source's `(kind, key)`
/// pair. The prefixes are the same ones `restore_rebuild.rs`'s
/// `infer_source_kind` recognizes in reverse (`project:scene:` for
/// `scene-body`, `snapshot:` for `snapshot-document`, ...) and the same
/// `sourceKind` vocabulary `reconciliation_envelope.rs`'s
/// `read_set_kind_for_source_kind`/`source_kind_for_read_set` validate
/// against. Kept here because this module owns the `source_object_identity`
/// string format; `restore_rebuild.rs` re-derives the reverse mapping
/// independently rather than importing this function (see that module's own
/// doc comment on why it duplicates rather than imports from a read-only
/// Lane).
///
/// No production caller today. Both Producer-time paths receive a
/// `source_key` that is *already* the fully-qualified identity -- the
/// envelope's `inputRef`, which `source_revision.rs`'s resolvers require to
/// carry its prefix -- so `repository.rs` and `legacy_backfill.rs` both copy
/// it rather than rebuild it here (rebuilding it is what produced the
/// `project:scene:project:scene:s1` double-prefix defect). This stays as the
/// canonical forward mapping, tested against all seven kinds below, for the
/// mutation-time changed-source locator that has to *construct* an identity
/// from a Change Feed event's `(kind, key)` rather than receive one.
pub(crate) fn source_identity_prefix_for(source_kind: &str) -> anyhow::Result<&'static str> {
    // `resolve_source_revision` dispatches on `domain-projection | projection`
    // and `evidence-anchor | evidence`, so both spellings must resolve here
    // too or a legitimate envelope would fail canonicalization.
    Ok(match source_kind {
        "scene-body" => "project:scene:",
        "snapshot-document" => "snapshot:",
        "codex-catalog" => "project:codex-catalog:",
        "domain-projection" | "projection" => "projection:",
        "narrative-artifact" => "artifact:",
        "import-capture" => "capture:",
        "evidence-anchor" | "evidence" => "evidence:",
        other => {
            anyhow::bail!("NEX_DEPENDENCY_SOURCE_KIND_INVALID: unsupported source kind '{other}'")
        }
    })
}

/// Every identity prefix, longest first so `project:codex-catalog:` is tested
/// before any shorter `project:`-shaped one could shadow it.
pub(crate) const SOURCE_IDENTITY_PREFIXES: &[&str] = &[
    "project:codex-catalog:",
    "project:scene:",
    "projection:",
    "snapshot:",
    "artifact:",
    "capture:",
    "evidence:",
];

fn starts_with_any_source_prefix(value: &str) -> bool {
    SOURCE_IDENTITY_PREFIXES
        .iter()
        .any(|prefix| value.starts_with(prefix))
}

/// The one place a `(source_kind, source_key)` pair becomes a
/// `source_object_identity`, for every writer and for SCHEMA 28's repair.
///
/// Idempotent by construction: a key that already carries its own kind's
/// prefix is returned unchanged, so running it twice cannot double-prefix
/// the way `record_run_dependency_edges_in_tx` once did.
///
/// The bare-key rule is not a style choice, it mirrors what
/// `source_revision.rs`'s resolvers actually accept.
/// `resolve_domain_projection` alone falls back to `.unwrap_or(source_key)`,
/// so a bare `projection-1` is a *valid* envelope today -- but
/// `restore_rebuild.rs`'s `infer_source_kind` only recognises identities that
/// start with `projection:`, so storing that bare key verbatim produced an
/// Edge the Evaluator reads as an unknown Source. Adding the prefix here is
/// what closes that gap. Every other kind's resolver rejects a bare key with
/// `NEX_SOURCE_KEY_INVALID`, so a bare key for those is malformed input and
/// fails closed rather than being silently decorated into something that
/// resolves to a different object than the caller meant.
///
/// A key carrying a *different* kind's prefix always fails closed, as does a
/// key whose remainder is itself prefixed -- the stored shape of the
/// double-prefix defect. Repairing those is SCHEMA 28's job, not a writer's.
pub(crate) fn canonical_source_object_identity(
    source_kind: &str,
    source_key: &str,
) -> anyhow::Result<String> {
    let prefix = source_identity_prefix_for(source_kind)?;
    anyhow::ensure!(
        !source_key.is_empty(),
        "NEX_SOURCE_KEY_INVALID: {source_kind} sourceKey must not be empty"
    );

    if let Some(rest) = source_key.strip_prefix(prefix) {
        anyhow::ensure!(
            !rest.is_empty(),
            "NEX_SOURCE_KEY_INVALID: {source_kind} sourceKey must be {prefix}<id>"
        );
        anyhow::ensure!(
            !starts_with_any_source_prefix(rest),
            "NEX_SOURCE_KEY_INVALID: {source_kind} sourceKey '{source_key}' is already prefixed twice"
        );
        return Ok(source_key.to_string());
    }

    anyhow::ensure!(
        !starts_with_any_source_prefix(source_key),
        "NEX_SOURCE_KEY_KIND_MISMATCH: {source_kind} sourceKey '{source_key}' carries another source kind's prefix"
    );

    match source_kind {
        "domain-projection" | "projection" => Ok(format!("{prefix}{source_key}")),
        other => anyhow::bail!(
            "NEX_SOURCE_KEY_INVALID: {other} sourceKey must be {prefix}<id>, got '{source_key}'"
        ),
    }
}

/// One row of `narrative_dependency_edges`: a declaration that Consumer
/// `(consumer_kind, consumer_key)` read Source `source_object_identity` when
/// it last produced its current output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DependencyEdge {
    pub id: String,
    pub project_id: String,
    pub consumer_kind: String,
    pub consumer_key: String,
    pub source_object_identity: String,
    pub read_set_json: String,
    pub generated_by_transaction_id: Option<String>,
    pub created_at: String,
    /// The Run that declared this Edge (SCHEMA 30). Provenance, not a
    /// derivation: it stays true after the Proposal the declaration came from
    /// is gone. `None` for an Edge whose declaring Run could not be
    /// identified -- `restore_rebuild` reports that instead of guessing.
    pub owning_run_id: Option<String>,
}

fn row_to_edge(row: &Row<'_>) -> rusqlite::Result<DependencyEdge> {
    Ok(DependencyEdge {
        id: row.get(0)?,
        project_id: row.get(1)?,
        consumer_kind: row.get(2)?,
        consumer_key: row.get(3)?,
        source_object_identity: row.get(4)?,
        read_set_json: row.get(5)?,
        generated_by_transaction_id: row.get(6)?,
        created_at: row.get(7)?,
        owning_run_id: row.get(8)?,
    })
}

/// Producer-time write. Declares (or re-declares) that a Consumer's most
/// recent generation read `source_object_identity`. Callers are existing
/// Artifact/Proposal/Application generation paths running inside their own
/// transaction; this function does not begin or commit one.
///
/// `read_set_json` must be a JSON array (matching the table's
/// `json_type(read_set_json) = 'array'` CHECK) and is validated up front so
/// a malformed caller fails closed before touching the database. Re-running
/// the same Producer for the same `(project_id, consumer_kind, consumer_key,
/// source_object_identity)` key upserts in place rather than accumulating
/// duplicate Edge rows.
///
/// The Consumer identity is validated here too
/// ([`validate_consumer_identity`]), because the table's own `CHECK`s only
/// require non-empty strings. A `consumer_kind` carrying the `finding_key`
/// separator would silently collide two unrelated Consumers onto one
/// Maintenance Attention row, which no constraint SQLite can express would
/// catch. This is the Producer-time gate; the read side stays tolerant of
/// whatever is already stored.
///
/// Returns the Edge's `id` (stable across upserts of the same key).
#[allow(clippy::too_many_arguments)]
pub(crate) fn record_dependency_edge_in_tx(
    conn: &Connection,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
    source_object_identity: &str,
    read_set_json: &str,
    generated_by_transaction_id: Option<&str>,
    owning_run_id: Option<&str>,
    created_at: &str,
) -> anyhow::Result<String> {
    validate_consumer_identity(consumer_kind, consumer_key)?;
    serde_json::from_str::<Vec<serde_json::Value>>(read_set_json).map_err(|error| {
        anyhow::anyhow!(
            "NEX_DEPENDENCY_READ_SET_INVALID: readSetJson must be a JSON array: {error}"
        )
    })?;

    let candidate_id = uuid::Uuid::new_v4().to_string();
    let id: String = conn.query_row(
        "INSERT INTO narrative_dependency_edges (
             id, project_id, consumer_kind, consumer_key, source_object_identity,
             read_set_json, generated_by_transaction_id, created_at, owning_run_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(project_id, consumer_kind, consumer_key, source_object_identity)
         DO UPDATE SET
             read_set_json = excluded.read_set_json,
             generated_by_transaction_id = excluded.generated_by_transaction_id,
             created_at = excluded.created_at,
             owning_run_id = excluded.owning_run_id
         RETURNING id",
        params![
            candidate_id,
            project_id,
            consumer_kind,
            consumer_key,
            source_object_identity,
            read_set_json,
            generated_by_transaction_id,
            created_at,
            owning_run_id,
        ],
        |row| row.get(0),
    )?;
    Ok(id)
}

/// The digest of the identity set `(project_id, consumer_kind,
/// consumer_key)` currently depends on: `compute_dependency_set_digest`
/// over every one of the Consumer's Dependency Edges'
/// `source_object_identity`.
///
/// This is the Consumer-grained counterpart of
/// `narrative_semantic_index_metadata.dependency_set_digest`, and it is a
/// *set* digest, not a content digest: it changes when the Consumer starts
/// or stops depending on a Source, not when a Source it already depends on
/// is edited (that is what Edge State and the rolled-up Freshness are for).
/// Together they answer the two questions a Verify has to separate -- "is
/// what this Consumer read still current?" and "is this Consumer still
/// reading the same things?" -- which the Run Kind Policy names
/// `consumer-freshness-dependency-set-digest`.
///
/// Returns the digest of the empty set for a Consumer with no Edges. That
/// is a real, distinguishable value rather than `None`: "this Consumer
/// depends on nothing" and "this Consumer's dependency set was never
/// computed" are different facts, and only the latter is NULL.
pub(crate) fn consumer_dependency_set_digest(
    conn: &Connection,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
) -> anyhow::Result<String> {
    let mut statement = conn.prepare(
        "SELECT source_object_identity
           FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
    )?;
    let identities = statement
        .query_map(params![project_id, consumer_kind, consumer_key], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // `compute_dependency_set_digest` sorts and length-prefixes internally,
    // so no ORDER BY is needed for determinism here.
    Ok(compute_dependency_set_digest(&identities))
}

/// Mutation-time Reverse Dependency Lookup: every Consumer that declared a
/// read of `source_object_identity` in this project. This is the core query
/// the Freshness re-evaluation flow uses after a Source mutation lands on
/// the Change Feed.
/// No production caller yet -- the Change Feed-driven Freshness
/// re-evaluation flow this Reverse Dependency Lookup is designed for
/// (see `publish_runtime.rs`'s module doc pipeline diagram) has not
/// landed.
#[allow(dead_code)]
pub(crate) fn find_edges_by_source(
    conn: &Connection,
    project_id: &str,
    source_object_identity: &str,
) -> anyhow::Result<Vec<DependencyEdge>> {
    let mut statement = conn.prepare(
        "SELECT id, project_id, consumer_kind, consumer_key, source_object_identity,
                read_set_json, generated_by_transaction_id, created_at, owning_run_id
           FROM narrative_dependency_edges
          WHERE project_id = ?1 AND source_object_identity = ?2
          ORDER BY consumer_kind ASC, consumer_key ASC",
    )?;
    let rows = statement.query_map(params![project_id, source_object_identity], row_to_edge)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Forward lookup: every Source a given Consumer currently declares a
/// dependency on.
pub(crate) fn find_edges_by_consumer(
    conn: &Connection,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
) -> anyhow::Result<Vec<DependencyEdge>> {
    let mut statement = conn.prepare(
        "SELECT id, project_id, consumer_kind, consumer_key, source_object_identity,
                read_set_json, generated_by_transaction_id, created_at, owning_run_id
           FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3
          ORDER BY source_object_identity ASC",
    )?;
    let rows = statement.query_map(
        params![project_id, consumer_kind, consumer_key],
        row_to_edge,
    )?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Clears every Edge a Consumer previously declared, so a re-run Producer
/// can re-declare its current read set from a clean slate instead of
/// accumulating Edges to Sources it no longer reads. Ambient-transaction
/// helper: no `BEGIN`/`COMMIT` of its own.
///
/// No production caller yet -- the re-run Producer flow this clean-slate
/// helper is designed for has not landed.
#[allow(dead_code)]
pub(crate) fn delete_edges_for_consumer_in_tx(
    conn: &Connection,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
        params![project_id, consumer_kind, consumer_key],
    )?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
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
            Ok(())
        })
        .expect("seed project");
        db
    }

    #[test]
    fn record_and_find_by_source_and_consumer_round_trip() {
        let db = test_db();
        db.with_conn(|conn| {
            let id = record_dependency_edge_in_tx(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
                r#"["/body","/title"]"#,
                Some("tx-1"),
                None,
                "2026-08-15T00:00:00.000Z")?;
            assert!(!id.is_empty());

            let by_source = find_edges_by_source(conn, "project-1", "project:scene:scene-1")?;
            assert_eq!(by_source.len(), 1);
            assert_eq!(by_source[0].id, id);
            assert_eq!(by_source[0].project_id, "project-1");
            assert_eq!(by_source[0].consumer_kind, "proposal");
            assert_eq!(by_source[0].consumer_key, "proposal-1");
            assert_eq!(by_source[0].read_set_json, r#"["/body","/title"]"#);
            assert_eq!(
                by_source[0].generated_by_transaction_id.as_deref(),
                Some("tx-1")
            );

            let by_consumer = find_edges_by_consumer(conn, "project-1", "proposal", "proposal-1")?;
            assert_eq!(by_consumer.len(), 1);
            assert_eq!(
                by_consumer[0].source_object_identity,
                "project:scene:scene-1"
            );

            // Unrelated Source/Consumer keys must not match.
            assert!(find_edges_by_source(conn, "project-1", "project:scene:scene-2")?.is_empty());
            assert!(
                find_edges_by_consumer(conn, "project-1", "proposal", "proposal-2")?.is_empty()
            );
            Ok(())
        })
        .expect("record and find edges");
    }

    #[test]
    fn upsert_on_same_key_updates_in_place_without_duplicating() {
        let db = test_db();
        db.with_conn(|conn| {
            let first_id = record_dependency_edge_in_tx(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
                r#"["/body"]"#,
                Some("tx-1"),
                None,
                "2026-08-15T00:00:00.000Z")?;

            let second_id = record_dependency_edge_in_tx(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
                r#"["/body","/title"]"#,
                Some("tx-2"),
                None,
                "2026-08-15T01:00:00.000Z")?;

            assert_eq!(first_id, second_id, "upsert must keep the original edge id");

            let edges = find_edges_by_source(conn, "project-1", "project:scene:scene-1")?;
            assert_eq!(edges.len(), 1, "re-run must not create a duplicate row");
            assert_eq!(edges[0].read_set_json, r#"["/body","/title"]"#);
            assert_eq!(
                edges[0].generated_by_transaction_id.as_deref(),
                Some("tx-2")
            );
            assert_eq!(edges[0].created_at, "2026-08-15T01:00:00.000Z");
            Ok(())
        })
        .expect("upsert edge");
    }

    /// The Producer-time gate this module's doc comment claims, exercised
    /// through the writer rather than only through
    /// `validate_consumer_identity` itself -- otherwise deleting the call
    /// leaves every test in this crate green while two unrelated Consumers
    /// start sharing one `finding_key`, and with it one human disposition.
    #[test]
    fn a_consumer_kind_carrying_the_finding_key_separator_fails_closed() {
        let db = test_db();
        db.with_conn(|conn| {
            // ("a:b", "c") and ("a", "b:c") both render as "a:b:c".
            let collides = record_dependency_edge_in_tx(
                conn,
                "project-1",
                "a:b",
                "c",
                "project:scene:scene-1",
                r#"["/body"]"#,
                None,
                None,
                "2026-08-15T00:00:00.000Z");
            assert!(collides
                .expect_err("a consumer kind containing the separator must be refused")
                .to_string()
                .contains("NEX_CONSUMER_KIND_INVALID"));

            for (kind, key) in [("", "run-1"), (RUN_CONSUMER_KIND, ""), (" padded", "run-1")] {
                assert!(
                    record_dependency_edge_in_tx(
                        conn,
                        "project-1",
                        kind,
                        key,
                        "project:scene:scene-1",
                        r#"["/body"]"#,
                        None,
                        None,
                        "2026-08-15T00:00:00.000Z")
                    .is_err(),
                    "expected ({kind:?}, {key:?}) to be refused"
                );
            }

            // A key may carry separators; only the kind may not.
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                "semantic-index",
                "embeddings:v2",
                "project:scene:scene-1",
                r#"["/body"]"#,
                None,
                None,
                "2026-08-15T00:00:00.000Z")
            .expect("a compound consumer key is legitimate");
            Ok(())
        })
        .expect("consumer identity gate");
    }

    #[test]
    fn non_array_read_set_json_fails_closed() {
        let db = test_db();
        db.with_conn(|conn| {
            let result = record_dependency_edge_in_tx(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
                r#"{"not":"an array"}"#,
                None,
                None,
                "2026-08-15T00:00:00.000Z");
            assert!(result.is_err());
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("NEX_DEPENDENCY_READ_SET_INVALID"));

            // Malformed JSON entirely must also fail closed.
            let malformed = record_dependency_edge_in_tx(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
                "not json at all",
                None,
                None,
                "2026-08-15T00:00:00.000Z");
            assert!(malformed.is_err());

            // Nothing should have been persisted by either failed attempt.
            assert!(find_edges_by_source(conn, "project-1", "project:scene:scene-1")?.is_empty());
            Ok(())
        })
        .expect("reject invalid read set json");
    }

    #[test]
    fn edges_are_scoped_to_project() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-2', 'Project Two')",
                [],
            )?;

            record_dependency_edge_in_tx(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
                r#"["/body"]"#,
                None,
                None,
                "2026-08-15T00:00:00.000Z")?;
            record_dependency_edge_in_tx(
                conn,
                "project-2",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
                r#"["/body"]"#,
                None,
                None,
                "2026-08-15T00:00:00.000Z")?;

            let project_1_by_source =
                find_edges_by_source(conn, "project-1", "project:scene:scene-1")?;
            assert_eq!(project_1_by_source.len(), 1);
            assert_eq!(project_1_by_source[0].project_id, "project-1");

            let project_2_by_consumer =
                find_edges_by_consumer(conn, "project-2", "proposal", "proposal-1")?;
            assert_eq!(project_2_by_consumer.len(), 1);
            assert_eq!(project_2_by_consumer[0].project_id, "project-2");

            delete_edges_for_consumer_in_tx(conn, "project-1", "proposal", "proposal-1")?;
            assert!(find_edges_by_source(conn, "project-1", "project:scene:scene-1")?.is_empty());
            // Deleting project-1's edge must not touch project-2's edge on
            // the same consumer/source keys.
            assert_eq!(
                find_edges_by_source(conn, "project-2", "project:scene:scene-1")?.len(),
                1
            );
            Ok(())
        })
        .expect("project isolation");
    }

    #[test]
    fn delete_edges_for_consumer_clears_only_that_consumer() {
        let db = test_db();
        db.with_conn(|conn| {
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
                r#"["/body"]"#,
                None,
                None,
                "2026-08-15T00:00:00.000Z")?;
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-2",
                r#"["/body"]"#,
                None,
                None,
                "2026-08-15T00:00:00.000Z")?;
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                "proposal",
                "proposal-2",
                "project:scene:scene-1",
                r#"["/body"]"#,
                None,
                None,
                "2026-08-15T00:00:00.000Z")?;

            delete_edges_for_consumer_in_tx(conn, "project-1", "proposal", "proposal-1")?;

            assert!(
                find_edges_by_consumer(conn, "project-1", "proposal", "proposal-1")?.is_empty()
            );
            // The other Consumer's edge on the same Source must survive.
            let remaining = find_edges_by_source(conn, "project-1", "project:scene:scene-1")?;
            assert_eq!(remaining.len(), 1);
            assert_eq!(remaining[0].consumer_key, "proposal-2");
            Ok(())
        })
        .expect("delete edges for consumer");
    }

    /// Every kind whose resolver in `source_revision.rs` requires the prefix.
    /// A key that already carries it is returned untouched.
    #[test]
    fn an_already_qualified_key_is_returned_unchanged() {
        for (kind, key) in [
            ("scene-body", "project:scene:scene-1"),
            ("snapshot-document", "snapshot:snap-1"),
            ("codex-catalog", "project:codex-catalog:entry-1"),
            ("domain-projection", "projection:proj-1"),
            ("narrative-artifact", "artifact:art-1"),
            ("import-capture", "capture:cap-1"),
            ("evidence-anchor", "evidence:ev-1"),
        ] {
            assert_eq!(
                canonical_source_object_identity(kind, key).unwrap(),
                key,
                "{kind} must be idempotent"
            );
        }
    }

    /// `resolve_source_revision` dispatches on both spellings, so a
    /// legitimate envelope using the short one must canonicalize too.
    #[test]
    fn source_kind_aliases_resolve_to_the_same_prefix() {
        assert_eq!(
            canonical_source_object_identity("projection", "proj-1").unwrap(),
            "projection:proj-1"
        );
        assert_eq!(
            canonical_source_object_identity("evidence", "evidence:ev-1").unwrap(),
            "evidence:ev-1"
        );
    }

    /// `resolve_domain_projection` is the only resolver that tolerates a bare
    /// key, so it is the only kind whose bare key gets decorated rather than
    /// rejected. `infer_source_kind` needs the prefix to recognise the Edge
    /// at all, which is why storing the bare form was a defect.
    #[test]
    fn only_domain_projection_accepts_a_bare_key() {
        assert_eq!(
            canonical_source_object_identity("domain-projection", "proj-1").unwrap(),
            "projection:proj-1"
        );
        for kind in [
            "scene-body",
            "snapshot-document",
            "codex-catalog",
            "narrative-artifact",
            "import-capture",
            "evidence-anchor",
        ] {
            let error = canonical_source_object_identity(kind, "bare-1")
                .expect_err("a bare key must not be accepted for {kind}");
            assert!(
                error.to_string().contains("NEX_SOURCE_KEY_INVALID"),
                "unexpected error for {kind}: {error}"
            );
        }
    }

    /// Decorating a key that already names a different kind would silently
    /// point the Edge at another object.
    #[test]
    fn a_key_carrying_another_kinds_prefix_fails_closed() {
        let error = canonical_source_object_identity("scene-body", "projection:proj-1")
            .expect_err("a cross-kind prefix must not be accepted");
        assert!(
            error.to_string().contains("NEX_SOURCE_KEY_KIND_MISMATCH"),
            "unexpected error: {error}"
        );
    }

    /// The stored shape of the pre-#535 defect. Repairing it belongs to
    /// SCHEMA 28; a writer handed one is looking at malformed input.
    #[test]
    fn an_already_doubled_prefix_fails_closed() {
        let error =
            canonical_source_object_identity("scene-body", "project:scene:project:scene:scene-1")
                .expect_err("a doubled prefix must not be accepted");
        assert!(
            error.to_string().contains("NEX_SOURCE_KEY_INVALID"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn canonical_source_object_identity_rejects_an_unrecognized_source_kind() {
        let result = canonical_source_object_identity("unknown-kind", "key-1");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("NEX_DEPENDENCY_SOURCE_KIND_INVALID"));
    }
}
