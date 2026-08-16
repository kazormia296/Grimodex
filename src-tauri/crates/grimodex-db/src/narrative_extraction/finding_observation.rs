//! Finding Observation persistence (Gate C2 Lane C).
//!
//! A Finding Observation is a rebuildable diagnostic record of what a Run
//! observed about a dependency edge / Freshness computation at a specific
//! Semantic Epoch — it is never the current value.
//! `policies/narrative/narrative-finding-contract.json` fixes
//! `observationStorageClass: "rebuildable-derived-state"`,
//! `epochBinding: "required"`, `freshnessSnapshotPolicy: "diagnostic-only"`,
//! and `currentFreshnessLookup: "narrative-consumer-freshness"`: the durable
//! Freshness authority lives in `narrative_consumer_freshness` only, and that
//! table belongs to a different Lane. This module writes and reads
//! `narrative_maintenance_finding_observations` rows and nothing else — it
//! never touches `narrative_consumer_freshness`, and it never touches
//! `narrative_maintenance_attention` (durable user Attention state, also a
//! different Lane's responsibility).

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use uuid::Uuid;

use super::evaluator::{EvidenceFreshness, FindingReasonCode};

/// One diagnostic row from `narrative_maintenance_finding_observations`.
///
/// This is history, not state: it is what a specific Run (`run_id`) observed
/// about `finding_key` as of a specific Semantic Epoch
/// (`semantic_epoch_id`). It is safe to delete and rebuild from a fresh Run
/// at any time — `observationStorageClass: "rebuildable-derived-state"`.
/// Never read this as the current Freshness value: that is
/// `narrative_consumer_freshness` alone (`currentFreshnessLookup`), which
/// this module does not read or write.
///
/// `pub`: reachable from `InboxEntry` (`inbox_read_model.rs`), which
/// crosses the N-API boundary (C2-T1).
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct FindingObservationRow {
    pub id: String,
    pub project_id: String,
    pub run_id: String,
    pub semantic_epoch_id: String,
    pub edge_id: Option<String>,
    pub finding_key: String,
    pub reason_code: FindingReasonCode,
    pub evidence_freshness_snapshot: EvidenceFreshness,
    pub material_basis_digest: String,
    pub observed_at: String,
}

/// Fail closed (mirrors `repository::ensure_run_project`) rather than let a
/// mismatched or missing Semantic Epoch silently attach an observation to
/// the wrong project.
fn ensure_epoch_project(
    conn: &Connection,
    project_id: &str,
    semantic_epoch_id: &str,
) -> anyhow::Result<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM narrative_semantic_epochs WHERE id = ?1",
            params![semantic_epoch_id],
            |row| row.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => anyhow::bail!(
            "NEX_FINDING_EPOCH_PROJECT_MISMATCH: semantic epoch does not belong to project"
        ),
        None => anyhow::bail!(
            "NEX_FINDING_EPOCH_MISSING: semantic epoch '{semantic_epoch_id}' was not found"
        ),
    }
}

/// Record one Finding Observation inside a caller-owned transaction.
///
/// Writes only `narrative_maintenance_finding_observations`. Never writes
/// `narrative_consumer_freshness` (the current-Freshness authority, a
/// separate Lane's table) or `narrative_maintenance_attention` (durable user
/// Attention state, also a separate Lane's table) — see the module doc
/// comment and `narrative-finding-contract.json`'s `freshnessSnapshotPolicy`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn record_finding_observation_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    semantic_epoch_id: &str,
    edge_id: Option<&str>,
    finding_key: &str,
    reason_code: FindingReasonCode,
    evidence_freshness_snapshot: EvidenceFreshness,
    material_basis_digest: &str,
    observed_at: &str,
) -> anyhow::Result<String> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!run_id.trim().is_empty(), "runId is required");
    anyhow::ensure!(
        !semantic_epoch_id.trim().is_empty(),
        "semanticEpochId is required"
    );
    anyhow::ensure!(!finding_key.trim().is_empty(), "findingKey is required");
    anyhow::ensure!(
        !material_basis_digest.trim().is_empty(),
        "materialBasisDigest is required"
    );
    anyhow::ensure!(!observed_at.trim().is_empty(), "observedAt is required");

    ensure_epoch_project(conn, project_id, semantic_epoch_id)?;

    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO narrative_maintenance_finding_observations
            (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
             reason_code, evidence_freshness_snapshot, material_basis_digest, observed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            project_id,
            run_id,
            semantic_epoch_id,
            edge_id,
            finding_key,
            reason_code.as_str(),
            evidence_freshness_snapshot.as_str(),
            material_basis_digest,
            observed_at,
        ],
    )?;
    Ok(id)
}

/// Read the diagnostic observation history for one `finding_key` at one
/// Semantic Epoch, oldest first. This is a pure read of past Run output —
/// diagnostic-only, never the current Freshness value. Callers that need the
/// current value must go through `narrative_consumer_freshness` instead
/// (`currentFreshnessLookup` in `narrative-finding-contract.json`); this
/// function intentionally has no "latest wins" / "current" framing.
pub(crate) fn list_observations_for_epoch(
    conn: &Connection,
    project_id: &str,
    semantic_epoch_id: &str,
    finding_key: &str,
) -> anyhow::Result<Vec<FindingObservationRow>> {
    let mut statement = conn.prepare(
        "SELECT id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
                reason_code, evidence_freshness_snapshot, material_basis_digest, observed_at
           FROM narrative_maintenance_finding_observations
          WHERE project_id = ?1 AND semantic_epoch_id = ?2 AND finding_key = ?3
          ORDER BY observed_at ASC, rowid ASC",
    )?;
    let raw_rows = statement
        .query_map(params![project_id, semantic_epoch_id, finding_key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    raw_rows
        .into_iter()
        .map(
            |(
                id,
                project_id,
                run_id,
                semantic_epoch_id,
                edge_id,
                finding_key,
                reason_code,
                evidence_freshness_snapshot,
                material_basis_digest,
                observed_at,
            )| {
                Ok(FindingObservationRow {
                    id,
                    project_id,
                    run_id,
                    semantic_epoch_id,
                    edge_id,
                    finding_key,
                    reason_code: FindingReasonCode::try_from(reason_code.as_str())?,
                    evidence_freshness_snapshot: EvidenceFreshness::try_from(
                        evidence_freshness_snapshot.as_str(),
                    )?,
                    material_basis_digest,
                    observed_at,
                })
            },
        )
        .collect::<anyhow::Result<Vec<_>>>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;

    fn open_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open db");
        db.migrate().expect("migrate");
        db
    }

    fn seed_project_and_epoch(conn: &Connection, project_id: &str, epoch_id: &str) {
        conn.execute("INSERT INTO projects (id) VALUES (?1)", params![project_id])
            .expect("seed project");
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', '2026-08-15T00:00:00.000Z')",
            params![epoch_id, project_id],
        )
        .expect("seed semantic epoch");
    }

    #[test]
    fn reason_code_round_trips_through_as_str_and_try_from() {
        let all = [
            FindingReasonCode::SourceRevisionChanged,
            FindingReasonCode::SourceMissing,
            FindingReasonCode::EvidenceOverlap,
            FindingReasonCode::ContextOverlap,
            FindingReasonCode::ExactContentRelocated,
            FindingReasonCode::QuoteNotFound,
            FindingReasonCode::QuoteAmbiguous,
            FindingReasonCode::ReadSetDrift,
            FindingReasonCode::NormalizerIncompatible,
            FindingReasonCode::ComponentIncompatible,
            FindingReasonCode::TargetModified,
        ];
        for code in all {
            let round_tripped = FindingReasonCode::try_from(code.as_str()).expect("round trip");
            assert_eq!(round_tripped, code);
        }
    }

    #[test]
    fn evidence_freshness_round_trips_through_as_str_and_try_from() {
        let all = [
            EvidenceFreshness::Fresh,
            EvidenceFreshness::Stale,
            EvidenceFreshness::SourceMissing,
            EvidenceFreshness::AnchorMismatch,
            EvidenceFreshness::ReadSetDrift,
            EvidenceFreshness::Unknown,
        ];
        for freshness in all {
            let round_tripped =
                EvidenceFreshness::try_from(freshness.as_str()).expect("round trip");
            assert_eq!(round_tripped, freshness);
        }
    }

    #[test]
    fn unknown_reason_code_fails_closed() {
        let error = FindingReasonCode::try_from("not-a-real-reason-code")
            .expect_err("unknown reason code must be rejected");
        assert!(error
            .to_string()
            .contains("NEX_FINDING_REASON_CODE_INVALID"));
    }

    #[test]
    fn unknown_evidence_freshness_fails_closed() {
        let error = EvidenceFreshness::try_from("not-a-real-freshness-value")
            .expect_err("unknown evidence freshness must be rejected");
        assert!(error.to_string().contains("NEX_EVIDENCE_FRESHNESS_INVALID"));
    }

    #[test]
    fn record_and_list_round_trip() {
        let db = open_db();
        db.with_conn(|conn| {
            seed_project_and_epoch(conn, "project-1", "epoch-1");

            let id = record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                "epoch-1",
                Some("edge-1"),
                "finding-1",
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                "sha256:material-basis",
                "2026-08-15T00:00:01.000Z",
            )
            .expect("record observation");
            assert!(!id.is_empty());

            let observations =
                list_observations_for_epoch(conn, "project-1", "epoch-1", "finding-1")
                    .expect("list observations");
            assert_eq!(observations.len(), 1);
            let observation = &observations[0];
            assert_eq!(observation.id, id);
            assert_eq!(observation.project_id, "project-1");
            assert_eq!(observation.run_id, "run-1");
            assert_eq!(observation.semantic_epoch_id, "epoch-1");
            assert_eq!(observation.edge_id.as_deref(), Some("edge-1"));
            assert_eq!(observation.finding_key, "finding-1");
            assert_eq!(
                observation.reason_code,
                FindingReasonCode::SourceRevisionChanged
            );
            assert_eq!(
                observation.evidence_freshness_snapshot,
                EvidenceFreshness::Stale
            );
            assert_eq!(observation.material_basis_digest, "sha256:material-basis");
            assert_eq!(observation.observed_at, "2026-08-15T00:00:01.000Z");

            // A second observation for the same finding_key is a distinct
            // history entry, not an overwrite — this table is an append-only
            // diagnostic log, not a current-value row.
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-2",
                "epoch-1",
                None,
                "finding-1",
                FindingReasonCode::QuoteAmbiguous,
                EvidenceFreshness::Unknown,
                "sha256:material-basis-2",
                "2026-08-15T00:00:02.000Z",
            )
            .expect("record second observation");
            let observations =
                list_observations_for_epoch(conn, "project-1", "epoch-1", "finding-1")
                    .expect("list observations after second write");
            assert_eq!(observations.len(), 2);
            assert_eq!(observations[1].edge_id, None);

            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn unknown_reason_code_is_rejected_before_any_write() {
        let db = open_db();
        db.with_conn(|conn| {
            seed_project_and_epoch(conn, "project-1", "epoch-1");
            assert!(FindingReasonCode::try_from("bogus-reason").is_err());
            let observations =
                list_observations_for_epoch(conn, "project-1", "epoch-1", "finding-1")
                    .expect("list observations");
            assert!(observations.is_empty());
            Ok(())
        })
        .expect("with_conn");
    }

    /// Negative fixture: `narrative-finding-contract.json`'s `negativeFixture`
    /// — writing a Finding Observation must never change
    /// `narrative_consumer_freshness`. This asserts the table is untouched by
    /// `record_finding_observation_in_tx`, both when it starts empty and when
    /// it already holds an unrelated current-Freshness row.
    #[test]
    fn recording_an_observation_never_touches_consumer_freshness() {
        let db = open_db();
        db.with_conn(|conn| {
            seed_project_and_epoch(conn, "project-1", "epoch-1");

            let freshness_rows_before: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM narrative_consumer_freshness",
                    [],
                    |row| row.get(0),
                )
                .expect("count freshness rows before");
            assert_eq!(freshness_rows_before, 0);

            // Seed an unrelated current-Freshness row that a different Lane
            // owns, to prove the write below leaves it byte-for-byte alone.
            conn.execute(
                "INSERT INTO narrative_consumer_freshness
                    (project_id, consumer_kind, consumer_key, evidence_freshness,
                     build_action, semantic_epoch_id, updated_at)
                 VALUES ('project-1', 'codex-entry', 'entry-1', 'fresh',
                         'none', 'epoch-1', '2026-08-15T00:00:00.000Z')",
                [],
            )
            .expect("seed unrelated freshness row");
            let freshness_snapshot_before: String = conn
                .query_row(
                    "SELECT evidence_freshness FROM narrative_consumer_freshness
                      WHERE project_id = 'project-1' AND consumer_kind = 'codex-entry'
                        AND consumer_key = 'entry-1'",
                    [],
                    |row| row.get(0),
                )
                .expect("read seeded freshness value");
            assert_eq!(freshness_snapshot_before, "fresh");

            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                "epoch-1",
                Some("edge-1"),
                "finding-1",
                FindingReasonCode::ContextOverlap,
                EvidenceFreshness::AnchorMismatch,
                "sha256:material-basis",
                "2026-08-15T00:00:03.000Z",
            )
            .expect("record observation");

            let freshness_rows_after: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM narrative_consumer_freshness",
                    [],
                    |row| row.get(0),
                )
                .expect("count freshness rows after");
            assert_eq!(
                freshness_rows_after, 1,
                "Finding Observation write must not insert/delete Freshness rows"
            );
            let freshness_snapshot_after: String = conn
                .query_row(
                    "SELECT evidence_freshness FROM narrative_consumer_freshness
                      WHERE project_id = 'project-1' AND consumer_kind = 'codex-entry'
                        AND consumer_key = 'entry-1'",
                    [],
                    |row| row.get(0),
                )
                .expect("read freshness value after");
            assert_eq!(
                freshness_snapshot_after, "fresh",
                "Finding Observation write must not mutate an existing Freshness row"
            );

            Ok(())
        })
        .expect("with_conn");
    }
}
