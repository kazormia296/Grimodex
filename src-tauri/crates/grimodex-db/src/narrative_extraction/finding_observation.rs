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

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use uuid::Uuid;

use super::consumer_identity::consumer_finding_key;
use super::evaluator::{EvidenceFreshness, FindingReasonCode};
use super::finding_identity::{
    material_basis_digest, observation_digest, stable_finding_identity, MaterialBasisInput,
    ObservationDigestInput, BUNDLED_FINDING_RULE_ID, BUNDLED_FINDING_RULE_VERSION,
};

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
    /// Stable identity derived from the bundled rule and durable subject. It
    /// is independent of the Run and Semantic Epoch that produced this row.
    /// NULL is retained for legacy rows whose Edge subject was deleted or
    /// never recorded; an edge-scoped rule must not use finding_key as a
    /// substitute identity.
    pub finding_identity: Option<String>,
    pub rule_id: String,
    pub rule_version: u32,
    /// Terminal maintenance failure code copied from the owning Run's
    /// execution ledger. Edge-scoped observations leave this `None`.
    pub failure_code: Option<String>,
    pub reason_code: FindingReasonCode,
    pub evidence_freshness_snapshot: EvidenceFreshness,
    /// Digest of the observed result. It deliberately excludes Run, Epoch,
    /// and wall-clock values so harmless reruns compare equal.
    pub observation_digest: String,
    pub material_basis_digest: String,
    pub observed_at: String,
}

/// The complete append-only input for a Finding Observation. The old helper
/// below remains as a compatibility wrapper for callers that have not yet
/// supplied the C2-3 identity fields.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FindingObservationWrite<'a> {
    pub project_id: &'a str,
    pub run_id: &'a str,
    pub semantic_epoch_id: &'a str,
    pub edge_id: Option<&'a str>,
    pub finding_key: &'a str,
    pub finding_identity: &'a str,
    pub rule_id: &'a str,
    pub rule_version: u32,
    pub reason_code: FindingReasonCode,
    pub evidence_freshness_snapshot: EvidenceFreshness,
    pub observation_digest: &'a str,
    pub material_basis_digest: &'a str,
    pub observed_at: &'a str,
}

type FindingObservationLookupRow = (
    Option<String>,
    String,
    String,
    String,
    i64,
    String,
    String,
    String,
    String,
);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FindingLifecycleState {
    New,
    Recurring,
    Changed,
    Resolved,
}

impl FindingLifecycleState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Recurring => "recurring",
            Self::Changed => "changed",
            Self::Resolved => "resolved",
        }
    }
}

impl TryFrom<&str> for FindingLifecycleState {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> anyhow::Result<Self> {
        match value {
            "new" => Ok(Self::New),
            "recurring" => Ok(Self::Recurring),
            "changed" => Ok(Self::Changed),
            "resolved" => Ok(Self::Resolved),
            other => {
                anyhow::bail!("NEX_FINDING_LIFECYCLE_INVALID: unknown lifecycle state '{other}'")
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct FindingLifecycleWrite<'a> {
    pub project_id: &'a str,
    pub finding_identity: &'a str,
    pub finding_key: &'a str,
    pub rule_id: &'a str,
    pub rule_version: u32,
    pub state: FindingLifecycleState,
    pub observation_digest: Option<&'a str>,
    pub material_basis_digest: Option<&'a str>,
    pub run_id: &'a str,
    pub semantic_epoch_id: &'a str,
    pub observed_at: &'a str,
}

/// Terminal maintenance observations have no Dependency Edge subject. Keep
/// their typed writer here so the observation table remains the sole owner of
/// Finding Observation persistence; the terminal projection module only
/// supplies validated work identity and failure evidence.
#[derive(Clone, Copy, Debug)]
pub(crate) struct TerminalFailureObservationWrite<'a> {
    pub project_id: &'a str,
    pub run_id: &'a str,
    pub semantic_epoch_id: &'a str,
    pub stable_subject: &'a str,
    pub finding_key: &'a str,
    pub finding_identity: &'a str,
    pub rule_id: &'a str,
    pub rule_version: u32,
    pub failure_code: &'a str,
    pub reason_code: FindingReasonCode,
    pub evidence_freshness_snapshot: EvidenceFreshness,
    pub observation_digest: &'a str,
    pub material_basis_digest: &'a str,
    pub observed_at: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TerminalFailureObservationOutcome {
    pub id: String,
    pub inserted: bool,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct TerminalFailureLifecycleWrite<'a> {
    pub project_id: &'a str,
    pub run_id: &'a str,
    pub semantic_epoch_id: &'a str,
    pub stable_subject: &'a str,
    pub finding_identity: &'a str,
    pub finding_key: &'a str,
    pub rule_id: &'a str,
    pub rule_version: u32,
    pub state: FindingLifecycleState,
    pub failure_code: &'a str,
    pub reason_code: FindingReasonCode,
    pub evidence_freshness_snapshot: EvidenceFreshness,
    pub observation_digest: &'a str,
    pub material_basis_digest: &'a str,
    pub observed_at: &'a str,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct TerminalFailureResolutionWrite<'a> {
    pub project_id: &'a str,
    pub run_id: &'a str,
    pub semantic_epoch_id: &'a str,
    pub stable_subject: &'a str,
    pub finding_identity: &'a str,
    pub finding_key: &'a str,
    pub rule_id: &'a str,
    pub rule_version: u32,
    pub material_basis_digest: &'a str,
    pub observed_at: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct FindingLifecycleRow {
    pub id: String,
    pub project_id: String,
    pub finding_identity: String,
    pub finding_key: String,
    pub rule_id: String,
    pub rule_version: u32,
    pub state: FindingLifecycleState,
    pub observation_digest: Option<String>,
    pub material_basis_digest: Option<String>,
    pub run_id: String,
    pub semantic_epoch_id: String,
    pub observed_at: String,
}

fn row_to_finding_lifecycle(row: &Row<'_>) -> rusqlite::Result<FindingLifecycleRow> {
    let state: String = row.get("lifecycle_state")?;
    let rule_version: i64 = row.get("rule_version")?;
    Ok(FindingLifecycleRow {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        finding_identity: row.get("finding_identity")?,
        finding_key: row.get("finding_key")?,
        rule_id: row.get("rule_id")?,
        rule_version: u32::try_from(rule_version).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Integer,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "finding rule version is outside u32",
                )),
            )
        })?,
        state: FindingLifecycleState::try_from(state.as_str()).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    error.to_string(),
                )),
            )
        })?,
        observation_digest: row.get("observation_digest")?,
        material_basis_digest: row.get("material_basis_digest")?,
        run_id: row.get("run_id")?,
        semantic_epoch_id: row.get("semantic_epoch_id")?,
        observed_at: row.get("observed_at")?,
    })
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
#[allow(clippy::too_many_arguments, dead_code)]
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
    let edge_id = edge_id.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_FINDING_EDGE_REQUIRED: edge-scoped Finding observations cannot be written without edgeId"
        )
    })?;
    let stable_subject = edge_id;
    let finding_identity = stable_finding_identity(
        BUNDLED_FINDING_RULE_ID,
        BUNDLED_FINDING_RULE_VERSION,
        stable_subject,
    )?;
    let digest_input = ObservationDigestInput {
        stable_subject,
        edge_id: Some(edge_id),
        failure_code: None,
        reason_code: reason_code.as_str(),
        evidence_freshness: evidence_freshness_snapshot.as_str(),
    };
    let observation_digest = observation_digest(
        BUNDLED_FINDING_RULE_ID,
        BUNDLED_FINDING_RULE_VERSION,
        &digest_input,
    )?;
    record_finding_observation_with_identity_in_tx(
        conn,
        FindingObservationWrite {
            project_id,
            run_id,
            semantic_epoch_id,
            edge_id: Some(edge_id),
            finding_key,
            finding_identity: &finding_identity,
            rule_id: BUNDLED_FINDING_RULE_ID,
            rule_version: BUNDLED_FINDING_RULE_VERSION,
            reason_code,
            evidence_freshness_snapshot,
            observation_digest: &observation_digest,
            material_basis_digest,
            observed_at,
        },
    )
}

pub(crate) fn record_finding_observation_with_identity_in_tx(
    conn: &Connection,
    write: FindingObservationWrite<'_>,
) -> anyhow::Result<String> {
    anyhow::ensure!(!write.project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!write.run_id.trim().is_empty(), "runId is required");
    anyhow::ensure!(
        !write.semantic_epoch_id.trim().is_empty(),
        "semanticEpochId is required"
    );
    anyhow::ensure!(
        !write.finding_key.trim().is_empty(),
        "findingKey is required"
    );
    anyhow::ensure!(
        !write.finding_identity.trim().is_empty(),
        "findingIdentity is required"
    );
    anyhow::ensure!(!write.rule_id.trim().is_empty(), "ruleId is required");
    anyhow::ensure!(write.rule_version > 0, "ruleVersion must be positive");
    anyhow::ensure!(
        !write.observation_digest.trim().is_empty(),
        "observationDigest is required"
    );
    anyhow::ensure!(
        !write.material_basis_digest.trim().is_empty(),
        "materialBasisDigest is required"
    );
    anyhow::ensure!(
        !write.observed_at.trim().is_empty(),
        "observedAt is required"
    );

    // Every live writer must use a rule that is present in the bundled,
    // executable registry. Unknown rules are never persisted.
    super::finding_identity::bundled_finding_rule_registry()?
        .resolve(write.rule_id, write.rule_version)?;
    let edge_id = write.edge_id.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_FINDING_EDGE_REQUIRED: edge-scoped Finding observations cannot be written without edgeId"
        )
    })?;
    let (edge_project_id, consumer_kind, consumer_key): (String, String, String) = conn
        .query_row(
            "SELECT project_id, consumer_kind, consumer_key
               FROM narrative_dependency_edges
              WHERE id = ?1",
            params![edge_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_FINDING_EDGE_MISSING: edgeId '{edge_id}' does not name an existing Dependency Edge"
            )
        })?;
    anyhow::ensure!(
        edge_project_id == write.project_id,
        "NEX_FINDING_EDGE_PROJECT_MISMATCH: edgeId '{edge_id}' belongs to project '{edge_project_id}', not '{}'",
        write.project_id
    );
    let canonical_finding_key = consumer_finding_key(&consumer_kind, &consumer_key);
    anyhow::ensure!(
        write.finding_key == canonical_finding_key,
        "NEX_FINDING_KEY_MISMATCH: supplied findingKey '{}' does not match the Edge Consumer key '{canonical_finding_key}'",
        write.finding_key
    );
    let expected_identity = stable_finding_identity(write.rule_id, write.rule_version, edge_id)?;
    anyhow::ensure!(
        write.finding_identity == expected_identity,
        "NEX_FINDING_IDENTITY_MISMATCH: supplied findingIdentity does not match the bundled rule and edgeId"
    );
    let expected_observation_digest = observation_digest(
        write.rule_id,
        write.rule_version,
        &ObservationDigestInput {
            stable_subject: edge_id,
            edge_id: Some(edge_id),
            failure_code: None,
            reason_code: write.reason_code.as_str(),
            evidence_freshness: write.evidence_freshness_snapshot.as_str(),
        },
    )?;
    anyhow::ensure!(
        write.observation_digest == expected_observation_digest,
        "NEX_FINDING_OBSERVATION_DIGEST_MISMATCH: supplied observationDigest does not match the declared result fields"
    );
    let expected_material_basis_digest = material_basis_digest(
        write.rule_id,
        write.rule_version,
        &MaterialBasisInput {
            stable_subject: edge_id,
            edge_id: Some(edge_id),
            failure_code: None,
            reason_code: write.reason_code.as_str(),
            evidence_freshness: write.evidence_freshness_snapshot.as_str(),
        },
    )?;
    anyhow::ensure!(
        write.material_basis_digest == expected_material_basis_digest,
        "NEX_FINDING_MATERIAL_BASIS_MISMATCH: supplied materialBasisDigest does not match the declared result fields"
    );
    ensure_epoch_project(conn, write.project_id, write.semantic_epoch_id)?;

    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO narrative_maintenance_finding_observations
            (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
             reason_code, evidence_freshness_snapshot, material_basis_digest, observed_at,
             finding_identity, rule_id, rule_version, observation_digest)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            id,
            write.project_id,
            write.run_id,
            write.semantic_epoch_id,
            write.edge_id,
            write.finding_key,
            write.reason_code.as_str(),
            write.evidence_freshness_snapshot.as_str(),
            write.material_basis_digest,
            write.observed_at,
            write.finding_identity,
            write.rule_id,
            i64::from(write.rule_version),
            write.observation_digest,
        ],
    )?;
    Ok(id)
}

/// Record one terminal maintenance failure observation. Unlike the existing
/// edge-scoped writer this intentionally stores `edge_id = NULL`; the stable
/// subject is the project/run-kind/work-key tuple supplied by the terminal
/// failure projector. Replaying the same Run is idempotent, while reusing a
/// Run id with different evidence fails closed.
pub(crate) fn record_terminal_failure_observation_in_tx(
    conn: &Connection,
    write: TerminalFailureObservationWrite<'_>,
) -> anyhow::Result<TerminalFailureObservationOutcome> {
    anyhow::ensure!(!write.project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!write.run_id.trim().is_empty(), "runId is required");
    anyhow::ensure!(
        !write.semantic_epoch_id.trim().is_empty(),
        "semanticEpochId is required"
    );
    anyhow::ensure!(
        !write.stable_subject.trim().is_empty(),
        "stableSubject is required"
    );
    anyhow::ensure!(
        !write.finding_key.trim().is_empty(),
        "findingKey is required"
    );
    anyhow::ensure!(
        !write.finding_identity.trim().is_empty(),
        "findingIdentity is required"
    );
    anyhow::ensure!(write.rule_version > 0, "ruleVersion must be positive");
    anyhow::ensure!(
        write.failure_code.starts_with("NEX_"),
        "NEX_FINDING_FAILURE_CODE_INVALID: failureCode must start with NEX_"
    );
    anyhow::ensure!(
        !write.observation_digest.trim().is_empty(),
        "observationDigest is required"
    );
    anyhow::ensure!(
        !write.material_basis_digest.trim().is_empty(),
        "materialBasisDigest is required"
    );
    anyhow::ensure!(
        !write.observed_at.trim().is_empty(),
        "observedAt is required"
    );

    let registry = super::finding_identity::bundled_finding_rule_registry()?;
    let rule = registry.resolve(write.rule_id, write.rule_version)?;
    anyhow::ensure!(
        rule.identity_scope == "maintenance-work",
        "NEX_FINDING_RULE_SCOPE_INVALID: terminal failure observations require the maintenance-work rule"
    );
    let expected_identity =
        stable_finding_identity(write.rule_id, write.rule_version, write.stable_subject)?;
    anyhow::ensure!(
        write.finding_identity == expected_identity,
        "NEX_FINDING_IDENTITY_MISMATCH: terminal failure identity is not proven by its work subject"
    );
    let expected_observation_digest = observation_digest(
        write.rule_id,
        write.rule_version,
        &ObservationDigestInput {
            stable_subject: write.stable_subject,
            edge_id: None,
            failure_code: Some(write.failure_code),
            reason_code: write.reason_code.as_str(),
            evidence_freshness: write.evidence_freshness_snapshot.as_str(),
        },
    )?;
    anyhow::ensure!(
        write.observation_digest == expected_observation_digest,
        "NEX_FINDING_OBSERVATION_DIGEST_MISMATCH: terminal failure digest is not proven by the declared result"
    );
    let expected_material_basis_digest = material_basis_digest(
        write.rule_id,
        write.rule_version,
        &MaterialBasisInput {
            stable_subject: write.stable_subject,
            edge_id: None,
            failure_code: Some(write.failure_code),
            reason_code: write.reason_code.as_str(),
            evidence_freshness: write.evidence_freshness_snapshot.as_str(),
        },
    )?;
    anyhow::ensure!(
        write.material_basis_digest == expected_material_basis_digest,
        "NEX_FINDING_MATERIAL_BASIS_MISMATCH: terminal failure basis is not proven by the declared result"
    );
    ensure_epoch_project(conn, write.project_id, write.semantic_epoch_id)?;

    let run: Option<(String, String)> = conn
        .query_row(
            "SELECT project_id, COALESCE(terminal_reason_code, '')
               FROM narrative_extraction_runs
              WHERE id = ?1",
            params![write.run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((run_project_id, terminal_reason_code)) = run else {
        anyhow::bail!(
            "NEX_FINDING_RUN_MISSING: run '{}' was not found",
            write.run_id
        );
    };
    anyhow::ensure!(
        run_project_id == write.project_id,
        "NEX_FINDING_RUN_PROJECT_MISMATCH: run belongs to another project"
    );
    anyhow::ensure!(
        terminal_reason_code == write.failure_code,
        "NEX_FINDING_FAILURE_CODE_MISMATCH: run terminal reason does not match the projected failure"
    );

    let existing: Option<(String, Option<String>, String, String)> = conn
        .query_row(
            "SELECT id, finding_identity, observation_digest, material_basis_digest
               FROM narrative_maintenance_finding_observations
              WHERE project_id = ?1 AND run_id = ?2 AND semantic_epoch_id = ?3
                AND finding_key = ?4 AND rule_id = ?5 AND rule_version = ?6
              LIMIT 1",
            params![
                write.project_id,
                write.run_id,
                write.semantic_epoch_id,
                write.finding_key,
                write.rule_id,
                i64::from(write.rule_version),
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((id, identity, observation, material_basis)) = existing {
        anyhow::ensure!(
            identity.as_deref() == Some(write.finding_identity)
                && observation == write.observation_digest
                && material_basis == write.material_basis_digest,
            "NEX_FINDING_OBSERVATION_REPLAY_CONFLICT: run already has different terminal failure evidence"
        );
        return Ok(TerminalFailureObservationOutcome {
            id,
            inserted: false,
        });
    }

    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO narrative_maintenance_finding_observations
            (id, project_id, run_id, semantic_epoch_id, edge_id, finding_key,
             reason_code, evidence_freshness_snapshot, material_basis_digest, observed_at,
             finding_identity, rule_id, rule_version, observation_digest)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            write.project_id,
            write.run_id,
            write.semantic_epoch_id,
            write.finding_key,
            write.reason_code.as_str(),
            write.evidence_freshness_snapshot.as_str(),
            write.material_basis_digest,
            write.observed_at,
            write.finding_identity,
            write.rule_id,
            i64::from(write.rule_version),
            write.observation_digest,
        ],
    )?;
    Ok(TerminalFailureObservationOutcome { id, inserted: true })
}

/// Append a lifecycle row for a terminal maintenance observation after the
/// observation writer has proven the exact rule, work identity, and digest.
pub(crate) fn record_terminal_failure_lifecycle_in_tx(
    conn: &Connection,
    write: TerminalFailureLifecycleWrite<'_>,
) -> anyhow::Result<bool> {
    anyhow::ensure!(
        !write.finding_identity.trim().is_empty()
            && !write.finding_key.trim().is_empty()
            && !write.failure_code.trim().is_empty(),
        "NEX_FINDING_LIFECYCLE_INVALID: terminal failure identity, key, and code are required"
    );
    anyhow::ensure!(
        write.state != FindingLifecycleState::Resolved,
        "NEX_FINDING_LIFECYCLE_INVALID: terminal failure lifecycle cannot be resolved in the active writer"
    );
    ensure_epoch_project(conn, write.project_id, write.semantic_epoch_id)?;
    let expected_identity =
        stable_finding_identity(write.rule_id, write.rule_version, write.stable_subject)?;
    anyhow::ensure!(
        expected_identity == write.finding_identity,
        "NEX_FINDING_LIFECYCLE_IDENTITY_MISMATCH: terminal lifecycle identity is not proven by its work subject"
    );
    let expected_observation_digest = observation_digest(
        write.rule_id,
        write.rule_version,
        &ObservationDigestInput {
            stable_subject: write.stable_subject,
            edge_id: None,
            failure_code: Some(write.failure_code),
            reason_code: write.reason_code.as_str(),
            evidence_freshness: write.evidence_freshness_snapshot.as_str(),
        },
    )?;
    let expected_material_basis_digest = material_basis_digest(
        write.rule_id,
        write.rule_version,
        &MaterialBasisInput {
            stable_subject: write.stable_subject,
            edge_id: None,
            failure_code: Some(write.failure_code),
            reason_code: write.reason_code.as_str(),
            evidence_freshness: write.evidence_freshness_snapshot.as_str(),
        },
    )?;
    anyhow::ensure!(
        write.observation_digest == expected_observation_digest
            && write.material_basis_digest == expected_material_basis_digest,
        "NEX_FINDING_LIFECYCLE_DIGEST_MISMATCH: terminal lifecycle evidence is not proven by the observation"
    );
    let observation: Option<(String, String, String, String, String)> = conn
        .query_row(
            "SELECT finding_identity, finding_key, observation_digest,
                    material_basis_digest, semantic_epoch_id
               FROM narrative_maintenance_finding_observations
              WHERE project_id = ?1 AND run_id = ?2 AND semantic_epoch_id = ?3
                AND finding_key = ?4 AND rule_id = ?5 AND rule_version = ?6
                AND edge_id IS NULL
              LIMIT 1",
            params![
                write.project_id,
                write.run_id,
                write.semantic_epoch_id,
                write.finding_key,
                write.rule_id,
                i64::from(write.rule_version),
            ],
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
        .optional()?;
    let Some((identity, finding_key, observation_digest, material_basis_digest, epoch_id)) =
        observation
    else {
        anyhow::bail!(
            "NEX_FINDING_LIFECYCLE_OBSERVATION_MISSING: terminal lifecycle has no matching observation"
        );
    };
    anyhow::ensure!(
        identity == write.finding_identity
            && finding_key == write.finding_key
            && epoch_id == write.semantic_epoch_id
            && observation_digest == write.observation_digest
            && material_basis_digest == write.material_basis_digest,
        "NEX_FINDING_LIFECYCLE_OBSERVATION_MISMATCH: terminal lifecycle does not match observation"
    );

    let existing: Option<String> = conn
        .query_row(
            "SELECT id
               FROM narrative_maintenance_finding_lifecycle
              WHERE project_id = ?1 AND finding_identity = ?2 AND run_id = ?3
                AND semantic_epoch_id = ?4 AND lifecycle_state = ?5
                AND observation_digest = ?6 AND material_basis_digest = ?7
              LIMIT 1",
            params![
                write.project_id,
                write.finding_identity,
                write.run_id,
                write.semantic_epoch_id,
                write.state.as_str(),
                write.observation_digest,
                write.material_basis_digest,
            ],
            |row| row.get(0),
        )
        .optional()?;
    if existing.is_some() {
        return Ok(false);
    }

    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO narrative_maintenance_finding_lifecycle
            (id, project_id, finding_identity, finding_key, rule_id, rule_version,
             lifecycle_state, observation_digest, material_basis_digest, run_id,
             semantic_epoch_id, observed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            id,
            write.project_id,
            write.finding_identity,
            write.finding_key,
            write.rule_id,
            i64::from(write.rule_version),
            write.state.as_str(),
            write.observation_digest,
            write.material_basis_digest,
            write.run_id,
            write.semantic_epoch_id,
            write.observed_at,
        ],
    )?;
    let _ = id;
    Ok(true)
}

/// Append a Resolved lifecycle row for the latest exact terminal failure
/// observation in the same Semantic Epoch.
pub(crate) fn resolve_terminal_failure_lifecycle_in_tx(
    conn: &Connection,
    write: TerminalFailureResolutionWrite<'_>,
) -> anyhow::Result<Option<String>> {
    ensure_epoch_project(conn, write.project_id, write.semantic_epoch_id)?;
    let expected_identity =
        stable_finding_identity(write.rule_id, write.rule_version, write.stable_subject)?;
    anyhow::ensure!(
        expected_identity == write.finding_identity,
        "NEX_FINDING_LIFECYCLE_RESOLVED_IDENTITY_MISMATCH: terminal identity is not proven by its work subject"
    );
    let prior: Option<(String, String, Option<String>)> = conn
        .query_row(
            "SELECT o.observation_digest, o.material_basis_digest,
                    r.terminal_reason_code
               FROM narrative_maintenance_finding_observations AS o
               JOIN narrative_extraction_runs AS r ON r.id = o.run_id
              WHERE o.project_id = ?1 AND o.semantic_epoch_id = ?2
                AND o.finding_identity = ?3 AND o.finding_key = ?4
                AND o.rule_id = ?5 AND o.rule_version = ?6
                AND o.edge_id IS NULL AND o.material_basis_digest = ?7
              ORDER BY o.rowid DESC
              LIMIT 1",
            params![
                write.project_id,
                write.semantic_epoch_id,
                write.finding_identity,
                write.finding_key,
                write.rule_id,
                i64::from(write.rule_version),
                write.material_basis_digest,
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((observation_digest, prior_material_basis_digest, failure_code)) = prior else {
        return Ok(None);
    };
    let failure_code = failure_code.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_FINDING_LIFECYCLE_RESOLVED_EVIDENCE_MISSING: terminal observation has no failure code"
        )
    })?;
    let expected_material_basis = material_basis_digest(
        write.rule_id,
        write.rule_version,
        &MaterialBasisInput {
            stable_subject: write.stable_subject,
            edge_id: None,
            failure_code: Some(&failure_code),
            reason_code: FindingReasonCode::ComponentIncompatible.as_str(),
            evidence_freshness: EvidenceFreshness::Unknown.as_str(),
        },
    )?;
    anyhow::ensure!(
        prior_material_basis_digest == expected_material_basis
            && prior_material_basis_digest == write.material_basis_digest,
        "NEX_FINDING_LIFECYCLE_RESOLVED_BASIS_MISMATCH: terminal basis is not proven by prior evidence"
    );
    let existing: Option<String> = conn
        .query_row(
            "SELECT id
               FROM narrative_maintenance_finding_lifecycle
              WHERE project_id = ?1 AND finding_identity = ?2 AND run_id = ?3
                AND semantic_epoch_id = ?4 AND lifecycle_state = 'resolved'
              LIMIT 1",
            params![
                write.project_id,
                write.finding_identity,
                write.run_id,
                write.semantic_epoch_id,
            ],
            |row| row.get(0),
        )
        .optional()?;
    if existing.is_some() {
        return Ok(existing);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO narrative_maintenance_finding_lifecycle
            (id, project_id, finding_identity, finding_key, rule_id, rule_version,
             lifecycle_state, observation_digest, material_basis_digest, run_id,
             semantic_epoch_id, observed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'resolved', NULL, ?7, ?8, ?9, ?10)",
        params![
            id,
            write.project_id,
            write.finding_identity,
            write.finding_key,
            write.rule_id,
            i64::from(write.rule_version),
            prior_material_basis_digest,
            write.run_id,
            write.semantic_epoch_id,
            write.observed_at,
        ],
    )?;
    // Keep this binding explicit: a resolution proves the prior observation,
    // but does not itself represent a new observation digest.
    let _ = observation_digest;
    Ok(Some(id))
}

pub(crate) fn record_finding_lifecycle_in_tx(
    conn: &Connection,
    write: FindingLifecycleWrite<'_>,
) -> anyhow::Result<String> {
    anyhow::ensure!(!write.project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(
        !write.finding_identity.trim().is_empty(),
        "findingIdentity is required"
    );
    anyhow::ensure!(
        !write.finding_key.trim().is_empty(),
        "findingKey is required"
    );
    anyhow::ensure!(!write.rule_id.trim().is_empty(), "ruleId is required");
    anyhow::ensure!(write.rule_version > 0, "ruleVersion must be positive");
    anyhow::ensure!(!write.run_id.trim().is_empty(), "runId is required");
    anyhow::ensure!(
        !write.semantic_epoch_id.trim().is_empty(),
        "semanticEpochId is required"
    );
    anyhow::ensure!(
        !write.observed_at.trim().is_empty(),
        "observedAt is required"
    );
    if let Some(digest) = write.observation_digest {
        anyhow::ensure!(
            !digest.trim().is_empty(),
            "observationDigest must not be empty"
        );
    }
    if let Some(digest) = write.material_basis_digest {
        anyhow::ensure!(
            !digest.trim().is_empty(),
            "materialBasisDigest must not be empty"
        );
    }
    match (write.state, write.observation_digest, write.material_basis_digest) {
        (FindingLifecycleState::Resolved, None, Some(_)) => {}
        (FindingLifecycleState::Resolved, Some(_), _) => anyhow::bail!(
            "NEX_FINDING_LIFECYCLE_RESOLVED_OBSERVATION_INVALID: resolved lifecycle must not carry an observation digest"
        ),
        (FindingLifecycleState::Resolved, None, None) => anyhow::bail!(
            "NEX_FINDING_LIFECYCLE_RESOLVED_EVIDENCE_MISSING: resolved lifecycle requires the prior material basis evidence"
        ),
        (_, Some(_), Some(_)) => {}
        (_, _, _) => anyhow::bail!(
            "NEX_FINDING_LIFECYCLE_EVIDENCE_MISSING: active lifecycle requires observation and material basis digests"
        ),
    }
    super::finding_identity::bundled_finding_rule_registry()?
        .resolve(write.rule_id, write.rule_version)?;
    ensure_epoch_project(conn, write.project_id, write.semantic_epoch_id)?;
    if let Some(lifecycle_observation_digest) = write.observation_digest {
        let observation: Option<FindingObservationLookupRow> = conn
            .query_row(
                "SELECT edge_id, finding_identity, material_basis_digest, rule_id,
                        rule_version, finding_key, reason_code,
                        evidence_freshness_snapshot, observation_digest
                   FROM narrative_maintenance_finding_observations
                  WHERE project_id = ?1 AND finding_identity = ?2
                    AND observation_digest = ?3 AND finding_key = ?4
                  ORDER BY observed_at DESC, rowid DESC
                  LIMIT 1",
                params![
                    write.project_id,
                    write.finding_identity,
                    lifecycle_observation_digest,
                    write.finding_key
                ],
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
            )
            .optional()?;
        let Some((
            edge_id,
            identity,
            material_basis,
            rule_id,
            rule_version,
            finding_key,
            reason_code,
            freshness,
            stored_observation_digest,
        )) = observation
        else {
            anyhow::bail!(
                "NEX_FINDING_LIFECYCLE_OBSERVATION_MISSING: lifecycle digest has no matching observation"
            );
        };
        let edge_id = edge_id.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_FINDING_LIFECYCLE_OBSERVATION_MISMATCH: observation has no Edge identity"
            )
        })?;
        anyhow::ensure!(
            identity == write.finding_identity
                && finding_key == write.finding_key
                && rule_id == write.rule_id
                && rule_version == i64::from(write.rule_version),
            "NEX_FINDING_LIFECYCLE_OBSERVATION_MISMATCH: lifecycle identity/rule does not match observation"
        );
        let expected_identity =
            stable_finding_identity(write.rule_id, write.rule_version, &edge_id)?;
        anyhow::ensure!(
            identity == expected_identity,
            "NEX_FINDING_LIFECYCLE_OBSERVATION_IDENTITY_MISMATCH: observation identity is not proven by its Edge"
        );
        let reason_code = FindingReasonCode::try_from(reason_code.as_str())?;
        let freshness = EvidenceFreshness::try_from(freshness.as_str())?;
        let expected_observation_digest = observation_digest(
            write.rule_id,
            write.rule_version,
            &ObservationDigestInput {
                stable_subject: &edge_id,
                edge_id: Some(&edge_id),
                failure_code: None,
                reason_code: reason_code.as_str(),
                evidence_freshness: freshness.as_str(),
            },
        )?;
        anyhow::ensure!(
            stored_observation_digest == lifecycle_observation_digest
                && lifecycle_observation_digest == expected_observation_digest,
            "NEX_FINDING_LIFECYCLE_OBSERVATION_DIGEST_MISMATCH: lifecycle digest is not proven by the observation result"
        );
        let active_basis_digest = write.material_basis_digest.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_FINDING_LIFECYCLE_MATERIAL_BASIS_MISSING: lifecycle observation requires a material basis"
            )
        })?;
        let expected_material_basis = material_basis_digest(
            write.rule_id,
            write.rule_version,
            &MaterialBasisInput {
                stable_subject: &edge_id,
                edge_id: Some(&edge_id),
                failure_code: None,
                reason_code: reason_code.as_str(),
                evidence_freshness: freshness.as_str(),
            },
        )?;
        anyhow::ensure!(
            material_basis == active_basis_digest
                && active_basis_digest == expected_material_basis,
            "NEX_FINDING_LIFECYCLE_MATERIAL_BASIS_MISMATCH: lifecycle basis is not proven by the observation result"
        );
    } else {
        // A Resolved row is not a finding observation, but it must still be
        // anchored to a previously observed, exact identity/key/rule/basis.
        // Otherwise any caller that knows a bundled rule could manufacture a
        // lifecycle closure for an identity that was never observed.
        let resolved_basis_digest = write.material_basis_digest.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_FINDING_LIFECYCLE_RESOLVED_EVIDENCE_MISSING: resolved lifecycle requires the prior material basis evidence"
            )
        })?;
        let prior_observation: Option<(String, String, String, String, String)> = conn
            .query_row(
                "SELECT edge_id, finding_identity, reason_code,
                        evidence_freshness_snapshot, material_basis_digest
                   FROM narrative_maintenance_finding_observations
                  WHERE project_id = ?1 AND finding_identity = ?2
                    AND finding_key = ?3 AND rule_id = ?4
                    AND rule_version = ?5
                    AND material_basis_digest = ?6
                  ORDER BY observed_at DESC, rowid DESC
                  LIMIT 1",
                params![
                    write.project_id,
                    write.finding_identity,
                    write.finding_key,
                    write.rule_id,
                    i64::from(write.rule_version),
                    resolved_basis_digest,
                ],
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
            .optional()?;
        let Some((edge_id, identity, reason_code, freshness, stored_material_basis)) =
            prior_observation
        else {
            anyhow::bail!(
                "NEX_FINDING_LIFECYCLE_RESOLVED_EVIDENCE_MISSING: resolved lifecycle has no exact prior observation"
            );
        };
        let expected_identity =
            stable_finding_identity(write.rule_id, write.rule_version, &edge_id)?;
        anyhow::ensure!(
            identity == write.finding_identity && identity == expected_identity,
            "NEX_FINDING_LIFECYCLE_RESOLVED_IDENTITY_MISMATCH: prior observation identity is not proven by its Edge"
        );
        let reason_code = FindingReasonCode::try_from(reason_code.as_str())?;
        let freshness = EvidenceFreshness::try_from(freshness.as_str())?;
        let expected_material_basis = material_basis_digest(
            write.rule_id,
            write.rule_version,
            &MaterialBasisInput {
                stable_subject: &edge_id,
                edge_id: Some(&edge_id),
                failure_code: None,
                reason_code: reason_code.as_str(),
                evidence_freshness: freshness.as_str(),
            },
        )?;
        anyhow::ensure!(
            stored_material_basis == expected_material_basis
                && resolved_basis_digest == expected_material_basis,
            "NEX_FINDING_LIFECYCLE_RESOLVED_BASIS_MISMATCH: resolved basis is not proven by the prior observation"
        );
    }

    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO narrative_maintenance_finding_lifecycle
            (id, project_id, finding_identity, finding_key, rule_id, rule_version,
             lifecycle_state, observation_digest, material_basis_digest, run_id,
             semantic_epoch_id, observed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            id,
            write.project_id,
            write.finding_identity,
            write.finding_key,
            write.rule_id,
            i64::from(write.rule_version),
            write.state.as_str(),
            write.observation_digest,
            write.material_basis_digest,
            write.run_id,
            write.semantic_epoch_id,
            write.observed_at,
        ],
    )?;
    Ok(id)
}

#[allow(dead_code)]
pub(crate) fn list_finding_lifecycle_for_identity(
    conn: &Connection,
    project_id: &str,
    finding_identity: &str,
) -> anyhow::Result<Vec<FindingLifecycleRow>> {
    let mut statement = conn.prepare(
        "SELECT id, project_id, finding_identity, finding_key, rule_id, rule_version,
                lifecycle_state, observation_digest, material_basis_digest, run_id,
                semantic_epoch_id, observed_at
           FROM narrative_maintenance_finding_lifecycle
          WHERE project_id = ?1 AND finding_identity = ?2
          ORDER BY observed_at ASC, rowid ASC",
    )?;
    let rows = statement
        .query_map(
            params![project_id, finding_identity],
            row_to_finding_lifecycle,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Read only the latest lifecycle transition for a stable Finding identity.
/// Publish uses this bounded read for its recurring/changed decision; the
/// append-only list API above remains available for diagnostics and tests.
pub(crate) fn latest_finding_lifecycle_for_identity(
    conn: &Connection,
    project_id: &str,
    finding_identity: &str,
) -> anyhow::Result<Option<FindingLifecycleRow>> {
    conn.query_row(
        "SELECT id, project_id, finding_identity, finding_key, rule_id, rule_version,
                lifecycle_state, observation_digest, material_basis_digest, run_id,
                semantic_epoch_id, observed_at
           FROM narrative_maintenance_finding_lifecycle
          WHERE project_id = ?1 AND finding_identity = ?2
          ORDER BY observed_at DESC, rowid DESC
          LIMIT 1",
        params![project_id, finding_identity],
        row_to_finding_lifecycle,
    )
    .optional()
    .map_err(Into::into)
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
        "SELECT o.id, o.project_id, o.run_id, o.semantic_epoch_id, o.edge_id, o.finding_key,
                o.reason_code, o.evidence_freshness_snapshot, o.material_basis_digest, o.observed_at,
                o.finding_identity, o.rule_id, o.rule_version, o.observation_digest,
                r.terminal_reason_code
           FROM narrative_maintenance_finding_observations AS o
           LEFT JOIN narrative_extraction_runs AS r
             ON r.id = o.run_id AND r.project_id = o.project_id
          WHERE o.project_id = ?1 AND o.semantic_epoch_id = ?2 AND o.finding_key = ?3
          ORDER BY o.observed_at ASC, o.rowid ASC",
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
                row.get::<_, Option<String>>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, i64>(12)?,
                row.get::<_, String>(13)?,
                row.get::<_, Option<String>>(14)?,
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
                finding_identity,
                rule_id,
                rule_version,
                observation_digest,
                failure_code,
            )| {
                Ok(FindingObservationRow {
                    id,
                    project_id,
                    run_id,
                    semantic_epoch_id,
                    edge_id,
                    finding_key,
                    finding_identity,
                    rule_id,
                    rule_version: u32::try_from(rule_version)
                        .map_err(|_| anyhow::anyhow!("finding rule version is outside u32"))?,
                    failure_code,
                    reason_code: FindingReasonCode::try_from(reason_code.as_str())?,
                    evidence_freshness_snapshot: EvidenceFreshness::try_from(
                        evidence_freshness_snapshot.as_str(),
                    )?,
                    observation_digest,
                    material_basis_digest,
                    observed_at,
                })
            },
        )
        .collect::<anyhow::Result<Vec<_>>>()
}

/// List terminal maintenance Finding keys for one Semantic Epoch. The Inbox
/// uses this read-only index to join directly to Observation history instead
/// of fabricating a Consumer Freshness row.
pub(crate) fn list_terminal_failure_finding_keys_for_epoch(
    conn: &Connection,
    project_id: &str,
    semantic_epoch_id: &str,
) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT finding_key
           FROM narrative_maintenance_finding_observations
          WHERE project_id = ?1 AND semantic_epoch_id = ?2
            AND rule_id = ?3 AND rule_version = ?4
          ORDER BY finding_key ASC",
    )?;
    let keys = statement
        .query_map(
            params![
                project_id,
                semantic_epoch_id,
                super::finding_identity::MAINTENANCE_FAILURE_FINDING_RULE_ID,
                i64::from(super::finding_identity::MAINTENANCE_FAILURE_FINDING_RULE_VERSION),
            ],
            |row| row.get(0),
        )?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(keys)
}

/// Return the durable Run rowid and material basis of the newest terminal
/// failure observation for an identity in one epoch. The terminal resolver
/// uses the Run ledger order to prove that a successful Run is newer than the
/// failure it closes; wall-clock timestamps are not sufficient for that OCC.
///
/// The current execution-state schema has no separate monotonic sequence
/// column, so SQLite's implicit rowid is the insertion sequence of the local
/// durable Run ledger. This is intentionally independent of `created_at`:
/// import/restore code must preserve Run insertion order when it rehydrates
/// the ledger, and callers cannot use equal or reordered wall-clock values to
/// close an older failure. A future explicit ledger sequence can replace this
/// read without changing the Finding identity contract.
pub(crate) fn latest_terminal_failure_observation_run_order(
    conn: &Connection,
    project_id: &str,
    semantic_epoch_id: &str,
    finding_identity: &str,
    finding_key: &str,
    rule_id: &str,
    rule_version: u32,
) -> anyhow::Result<Option<(i64, String)>> {
    conn.query_row(
        "SELECT r.rowid, o.material_basis_digest
           FROM narrative_maintenance_finding_observations AS o
           JOIN narrative_extraction_runs AS r ON r.id = o.run_id
          WHERE o.project_id = ?1 AND o.semantic_epoch_id = ?2
            AND o.finding_identity = ?3 AND o.finding_key = ?4
            AND o.rule_id = ?5 AND o.rule_version = ?6
            AND o.edge_id IS NULL
          ORDER BY r.rowid DESC, o.rowid DESC
          LIMIT 1",
        params![
            project_id,
            semantic_epoch_id,
            finding_identity,
            finding_key,
            rule_id,
            i64::from(rule_version),
        ],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::super::consumer_identity::consumer_finding_key;
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
        if project_id == "project-1" {
            for edge_id in ["edge-1", "edge-2"] {
                seed_dependency_edge(
                    conn,
                    edge_id,
                    project_id,
                    "narrative-extraction-run",
                    "run-1",
                );
            }
        }
    }

    fn seed_dependency_edge(
        conn: &Connection,
        edge_id: &str,
        project_id: &str,
        consumer_kind: &str,
        consumer_key: &str,
    ) {
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key, source_object_identity,
                 read_set_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, '[]', '2026-08-15T00:00:00.000Z')",
            params![
                edge_id,
                project_id,
                consumer_kind,
                consumer_key,
                format!("test-source:{edge_id}"),
            ],
        )
        .expect("seed dependency edge");
    }

    fn test_material_basis(
        edge_id: &str,
        reason_code: FindingReasonCode,
        freshness: EvidenceFreshness,
    ) -> String {
        material_basis_digest(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            &MaterialBasisInput {
                stable_subject: edge_id,
                edge_id: Some(edge_id),
                failure_code: None,
                reason_code: reason_code.as_str(),
                evidence_freshness: freshness.as_str(),
            },
        )
        .expect("material basis")
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
            let finding_key = consumer_finding_key("narrative-extraction-run", "run-1");

            let id = record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                "epoch-1",
                Some("edge-1"),
                &finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                ),
                "2026-08-15T00:00:01.000Z",
            )
            .expect("record observation");
            assert!(!id.is_empty());

            let observations =
                list_observations_for_epoch(conn, "project-1", "epoch-1", &finding_key)
                    .expect("list observations");
            assert_eq!(observations.len(), 1);
            let observation = &observations[0];
            assert_eq!(observation.id, id);
            assert_eq!(observation.project_id, "project-1");
            assert_eq!(observation.run_id, "run-1");
            assert_eq!(observation.semantic_epoch_id, "epoch-1");
            assert_eq!(observation.edge_id.as_deref(), Some("edge-1"));
            assert_eq!(observation.finding_key, finding_key);
            assert_eq!(
                observation.reason_code,
                FindingReasonCode::SourceRevisionChanged
            );
            assert_eq!(
                observation.evidence_freshness_snapshot,
                EvidenceFreshness::Stale
            );
            assert_eq!(
                observation.material_basis_digest,
                test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                )
            );
            assert_eq!(observation.observed_at, "2026-08-15T00:00:01.000Z");

            // A second observation for the same finding_key is a distinct
            // history entry, not an overwrite — this table is an append-only
            // diagnostic log, not a current-value row.
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-2",
                "epoch-1",
                Some("edge-2"),
                &finding_key,
                FindingReasonCode::QuoteAmbiguous,
                EvidenceFreshness::Unknown,
                &test_material_basis(
                    "edge-2",
                    FindingReasonCode::QuoteAmbiguous,
                    EvidenceFreshness::Unknown,
                ),
                "2026-08-15T00:00:02.000Z",
            )
            .expect("record second observation");
            let observations =
                list_observations_for_epoch(conn, "project-1", "epoch-1", &finding_key)
                    .expect("list observations after second write");
            assert_eq!(observations.len(), 2);
            assert_eq!(observations[1].edge_id.as_deref(), Some("edge-2"));

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
            let finding_key = consumer_finding_key("narrative-extraction-run", "run-1");
            let observations =
                list_observations_for_epoch(conn, "project-1", "epoch-1", &finding_key)
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
            let finding_key = consumer_finding_key("narrative-extraction-run", "run-1");

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
                &finding_key,
                FindingReasonCode::ContextOverlap,
                EvidenceFreshness::AnchorMismatch,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::ContextOverlap,
                    EvidenceFreshness::AnchorMismatch,
                ),
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

    #[test]
    fn stable_identity_and_digests_round_trip_with_observation_history() {
        let db = open_db();
        db.with_conn(|conn| {
            seed_project_and_epoch(conn, "project-1", "epoch-1");
            let finding_identity = stable_finding_identity(
                BUNDLED_FINDING_RULE_ID,
                BUNDLED_FINDING_RULE_VERSION,
                "edge-1",
            )
            .expect("identity");
            let observation_digest = observation_digest(
                BUNDLED_FINDING_RULE_ID,
                BUNDLED_FINDING_RULE_VERSION,
                &ObservationDigestInput {
                    stable_subject: "edge-1",
                    edge_id: Some("edge-1"),
                    failure_code: None,
                    reason_code: FindingReasonCode::SourceMissing.as_str(),
                    evidence_freshness: EvidenceFreshness::SourceMissing.as_str(),
                },
            )
            .expect("observation digest");
            let material_basis_digest = test_material_basis(
                "edge-1",
                FindingReasonCode::SourceMissing,
                EvidenceFreshness::SourceMissing,
            );

            record_finding_observation_with_identity_in_tx(
                conn,
                FindingObservationWrite {
                    project_id: "project-1",
                    run_id: "run-1",
                    semantic_epoch_id: "epoch-1",
                    edge_id: Some("edge-1"),
                    finding_key: "narrative-extraction-run:run-1",
                    finding_identity: &finding_identity,
                    rule_id: "narrative.consumer-freshness",
                    rule_version: 1,
                    reason_code: FindingReasonCode::SourceMissing,
                    evidence_freshness_snapshot: EvidenceFreshness::SourceMissing,
                    observation_digest: &observation_digest,
                    material_basis_digest: &material_basis_digest,
                    observed_at: "2026-08-15T00:00:04.000Z",
                },
            )?;

            let rows = list_observations_for_epoch(
                conn,
                "project-1",
                "epoch-1",
                "narrative-extraction-run:run-1",
            )?;
            assert_eq!(
                rows[0].finding_identity.as_deref(),
                Some(finding_identity.as_str())
            );
            assert_eq!(rows[0].rule_id, "narrative.consumer-freshness");
            assert_eq!(rows[0].rule_version, 1);
            assert_eq!(rows[0].observation_digest, observation_digest);
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn observation_writer_requires_project_owned_edge_and_canonical_finding_key() {
        let db = open_db();
        db.with_conn(|conn| {
            seed_project_and_epoch(conn, "project-1", "epoch-1");
            seed_project_and_epoch(conn, "project-2", "epoch-2");
            seed_dependency_edge(
                conn,
                "foreign-edge",
                "project-2",
                "narrative-extraction-run",
                "run-foreign",
            );

            let finding_identity = stable_finding_identity(
                BUNDLED_FINDING_RULE_ID,
                BUNDLED_FINDING_RULE_VERSION,
                "edge-1",
            )?;
            let observation_digest = observation_digest(
                BUNDLED_FINDING_RULE_ID,
                BUNDLED_FINDING_RULE_VERSION,
                &ObservationDigestInput {
                    stable_subject: "edge-1",
                    edge_id: Some("edge-1"),
                    failure_code: None,
                    reason_code: FindingReasonCode::SourceMissing.as_str(),
                    evidence_freshness: EvidenceFreshness::SourceMissing.as_str(),
                },
            )?;
            let material_basis_digest = test_material_basis(
                "edge-1",
                FindingReasonCode::SourceMissing,
                EvidenceFreshness::SourceMissing,
            );
            let canonical_key = consumer_finding_key("narrative-extraction-run", "run-1");

            let missing = record_finding_observation_with_identity_in_tx(
                conn,
                FindingObservationWrite {
                    project_id: "project-1",
                    run_id: "run-1",
                    semantic_epoch_id: "epoch-1",
                    edge_id: Some("missing-edge"),
                    finding_key: &canonical_key,
                    finding_identity: &finding_identity,
                    rule_id: BUNDLED_FINDING_RULE_ID,
                    rule_version: BUNDLED_FINDING_RULE_VERSION,
                    reason_code: FindingReasonCode::SourceMissing,
                    evidence_freshness_snapshot: EvidenceFreshness::SourceMissing,
                    observation_digest: &observation_digest,
                    material_basis_digest: &material_basis_digest,
                    observed_at: "2026-08-15T00:00:04.000Z",
                },
            )
            .expect_err("missing Edge must not accept an Observation");
            assert!(missing.to_string().contains("NEX_FINDING_EDGE_MISSING"));

            let foreign_key = consumer_finding_key("narrative-extraction-run", "run-foreign");
            let foreign = record_finding_observation_with_identity_in_tx(
                conn,
                FindingObservationWrite {
                    project_id: "project-1",
                    run_id: "run-1",
                    semantic_epoch_id: "epoch-1",
                    edge_id: Some("foreign-edge"),
                    finding_key: &foreign_key,
                    finding_identity: &finding_identity,
                    rule_id: BUNDLED_FINDING_RULE_ID,
                    rule_version: BUNDLED_FINDING_RULE_VERSION,
                    reason_code: FindingReasonCode::SourceMissing,
                    evidence_freshness_snapshot: EvidenceFreshness::SourceMissing,
                    observation_digest: &observation_digest,
                    material_basis_digest: &material_basis_digest,
                    observed_at: "2026-08-15T00:00:05.000Z",
                },
            )
            .expect_err("a foreign-project Edge must not accept an Observation");
            assert!(foreign
                .to_string()
                .contains("NEX_FINDING_EDGE_PROJECT_MISMATCH"));

            let key_mismatch = record_finding_observation_with_identity_in_tx(
                conn,
                FindingObservationWrite {
                    project_id: "project-1",
                    run_id: "run-1",
                    semantic_epoch_id: "epoch-1",
                    edge_id: Some("edge-1"),
                    finding_key: "wrong:consumer",
                    finding_identity: &finding_identity,
                    rule_id: BUNDLED_FINDING_RULE_ID,
                    rule_version: BUNDLED_FINDING_RULE_VERSION,
                    reason_code: FindingReasonCode::SourceMissing,
                    evidence_freshness_snapshot: EvidenceFreshness::SourceMissing,
                    observation_digest: &observation_digest,
                    material_basis_digest: &material_basis_digest,
                    observed_at: "2026-08-15T00:00:06.000Z",
                },
            )
            .expect_err("a caller-supplied non-canonical key must be rejected");
            assert!(key_mismatch
                .to_string()
                .contains("NEX_FINDING_KEY_MISMATCH"));

            let observation_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_maintenance_finding_observations",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(observation_count, 0);
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn lifecycle_records_explicit_resolved_state_and_changed_observation() {
        let db = open_db();
        db.with_conn(|conn| {
            seed_project_and_epoch(conn, "project-1", "epoch-1");
            let first_observation = record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                "epoch-1",
                Some("edge-1"),
                "narrative-extraction-run:run-1",
                FindingReasonCode::SourceMissing,
                EvidenceFreshness::SourceMissing,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceMissing,
                    EvidenceFreshness::SourceMissing,
                ),
                "2026-08-15T00:00:04.000Z",
            )?;
            let first_observation_digest: String = conn.query_row(
                "SELECT observation_digest FROM narrative_maintenance_finding_observations WHERE id = ?1",
                params![first_observation],
                |row| row.get(0),
            )?;
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                "epoch-1",
                Some("edge-1"),
                "narrative-extraction-run:run-1",
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                ),
                "2026-08-15T00:00:05.000Z",
            )?;
            let second_observation_digest: String = conn.query_row(
                "SELECT observation_digest FROM narrative_maintenance_finding_observations
                  WHERE project_id = 'project-1'
                    AND finding_key = 'narrative-extraction-run:run-1'
                  ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )?;
            let finding_identity = stable_finding_identity(
                BUNDLED_FINDING_RULE_ID,
                BUNDLED_FINDING_RULE_VERSION,
                "edge-1",
            )?;
            let base = FindingLifecycleWrite {
                project_id: "project-1",
                finding_identity: &finding_identity,
                finding_key: "narrative-extraction-run:run-1",
                rule_id: "narrative.consumer-freshness",
                rule_version: 1,
                run_id: "run-1",
                semantic_epoch_id: "epoch-1",
                state: FindingLifecycleState::New,
                observation_digest: None,
                material_basis_digest: Some(&test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceMissing,
                    EvidenceFreshness::SourceMissing,
                )),
                observed_at: "2026-08-15T00:00:05.000Z",
            };
            record_finding_lifecycle_in_tx(
                conn,
                FindingLifecycleWrite {
                    observation_digest: Some(&first_observation_digest),
                    state: FindingLifecycleState::New,
                    ..base
                },
            )?;
            record_finding_lifecycle_in_tx(
                conn,
                FindingLifecycleWrite {
                    observation_digest: Some(&second_observation_digest),
                    material_basis_digest: Some(&test_material_basis(
                        "edge-1",
                        FindingReasonCode::SourceRevisionChanged,
                        EvidenceFreshness::Stale,
                    )),
                    state: FindingLifecycleState::Changed,
                    observed_at: "2026-08-15T00:00:06.000Z",
                    ..base
                },
            )?;
            record_finding_lifecycle_in_tx(
                conn,
                FindingLifecycleWrite {
                    observation_digest: None,
                    state: FindingLifecycleState::Resolved,
                    observed_at: "2026-08-15T00:00:07.000Z",
                    ..base
                },
            )?;

            let states = list_finding_lifecycle_for_identity(
                conn,
                "project-1",
                &finding_identity,
            )?;
            assert_eq!(states.len(), 3);
            assert_eq!(states[0].state, FindingLifecycleState::New);
            assert_eq!(states[1].state, FindingLifecycleState::Changed);
            assert_eq!(states[2].state, FindingLifecycleState::Resolved);
            assert!(states[2].observation_digest.is_none());
            let latest = latest_finding_lifecycle_for_identity(
                conn,
                "project-1",
                &finding_identity,
            )?
            .expect("latest lifecycle row");
            assert_eq!(latest.id, states[2].id);
            assert_eq!(latest.state, FindingLifecycleState::Resolved);
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn lifecycle_writer_requires_exact_observation_key_and_resolved_evidence() {
        let db = open_db();
        db.with_conn(|conn| {
            seed_project_and_epoch(conn, "project-1", "epoch-1");
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                "epoch-1",
                Some("edge-1"),
                "narrative-extraction-run:run-1",
                FindingReasonCode::SourceMissing,
                EvidenceFreshness::SourceMissing,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceMissing,
                    EvidenceFreshness::SourceMissing,
                ),
                "2026-08-15T00:00:04.000Z",
            )?;
            let finding_identity = stable_finding_identity(
                BUNDLED_FINDING_RULE_ID,
                BUNDLED_FINDING_RULE_VERSION,
                "edge-1",
            )?;
            let observation_digest: String = conn.query_row(
                "SELECT observation_digest
                   FROM narrative_maintenance_finding_observations
                  WHERE project_id = 'project-1' AND finding_identity = ?1",
                params![finding_identity],
                |row| row.get(0),
            )?;
            let material_basis = test_material_basis(
                "edge-1",
                FindingReasonCode::SourceMissing,
                EvidenceFreshness::SourceMissing,
            );

            let key_mismatch = record_finding_lifecycle_in_tx(
                conn,
                FindingLifecycleWrite {
                    project_id: "project-1",
                    finding_identity: &finding_identity,
                    finding_key: "wrong:consumer",
                    rule_id: BUNDLED_FINDING_RULE_ID,
                    rule_version: BUNDLED_FINDING_RULE_VERSION,
                    state: FindingLifecycleState::New,
                    observation_digest: Some(&observation_digest),
                    material_basis_digest: Some(&material_basis),
                    run_id: "run-1",
                    semantic_epoch_id: "epoch-1",
                    observed_at: "2026-08-15T00:00:05.000Z",
                },
            )
            .expect_err("lifecycle must not borrow an observation under another finding key");
            assert!(key_mismatch
                .to_string()
                .contains("NEX_FINDING_LIFECYCLE_OBSERVATION_MISSING"));

            let unknown_identity = stable_finding_identity(
                BUNDLED_FINDING_RULE_ID,
                BUNDLED_FINDING_RULE_VERSION,
                "edge-never-observed",
            )?;
            let unknown_basis = test_material_basis(
                "edge-never-observed",
                FindingReasonCode::SourceMissing,
                EvidenceFreshness::SourceMissing,
            );
            let missing_resolved_evidence = record_finding_lifecycle_in_tx(
                conn,
                FindingLifecycleWrite {
                    project_id: "project-1",
                    finding_identity: &unknown_identity,
                    finding_key: "run:never-observed",
                    rule_id: BUNDLED_FINDING_RULE_ID,
                    rule_version: BUNDLED_FINDING_RULE_VERSION,
                    state: FindingLifecycleState::Resolved,
                    observation_digest: None,
                    material_basis_digest: Some(&unknown_basis),
                    run_id: "run-1",
                    semantic_epoch_id: "epoch-1",
                    observed_at: "2026-08-15T00:00:06.000Z",
                },
            )
            .expect_err("resolved lifecycle must be anchored to a prior observation");
            assert!(missing_resolved_evidence
                .to_string()
                .contains("NEX_FINDING_LIFECYCLE_RESOLVED_EVIDENCE_MISSING"));

            let lifecycle_rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_maintenance_finding_lifecycle",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(lifecycle_rows, 0);
            Ok(())
        })
        .expect("with_conn");
    }
}
