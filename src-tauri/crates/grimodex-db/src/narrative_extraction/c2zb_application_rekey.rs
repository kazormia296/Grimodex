//! SCHEMA 32 C2-ZB Application re-key migration.
//!
//! The migration is intentionally split into a read-only preflight and a
//! small write phase.  Its authority is the durable chain
//! `Application -> ApplyCommit.run_id -> projection dependency -> Run Edge`;
//! applied entity/proposal fields are never used to infer a mapping.  The
//! schema owner wraps this module in one savepoint spanning every project and
//! the completion marker.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use uuid::Uuid;

use super::c2z_preparation::{
    plan_application_rekey, ApplicationRekeyCandidate, ApplicationRekeyFanOut,
    ApplicationRekeyPlan, RekeyMappingKind, APPLICATION_CONSUMER_KIND,
};
use super::consumer_identity::{validate_consumer_identity, RUN_CONSUMER_KIND};
use super::dependency_edges::{
    canonical_source_object_identity, validate_stored_source_object_identity,
};
use super::finding_identity::stable_finding_identity;
use super::semantic_epoch::create_epoch_in_tx;

pub(crate) const C2_ZB_MIGRATION_ID: &str = "narrative-c2-application-rekey-v32";
pub(crate) const C2_ZB_CONTRACT_VERSION: i64 = 1;

const FINDING_RULE_ID: &str = "narrative.consumer-freshness";
const FINDING_RULE_VERSION: u32 = 1;

#[derive(Debug, Clone)]
struct ExistingApplicationEdge {
    id: String,
    read_set_json: String,
    owning_run_id: Option<String>,
    owning_project_id: Option<String>,
}

#[derive(Debug, Clone)]
struct EdgeMetadata {
    project_id: String,
    source_object_identity: String,
    generated_by_transaction_id: Option<String>,
    created_at: String,
}

#[derive(Debug, Clone, Default)]
struct FindingHistorySnapshot {
    observation_ids: Vec<String>,
    lifecycle_ids: Vec<String>,
    attention_keys: Vec<String>,
}

#[derive(Debug, Clone)]
struct AttentionRehome {
    application_id: String,
    expected_count: usize,
}

#[derive(Debug, Clone)]
struct ProjectPreflight {
    plan: ApplicationRekeyPlan,
    exact_history: BTreeMap<String, FindingHistorySnapshot>,
    attention_by_run: BTreeMap<String, AttentionRehome>,
}

/// Run the SCHEMA 32 data migration.  The caller owns the surrounding
/// savepoint; this function does not begin or commit a transaction.
///
/// Returns `true` when the data phase ran and the caller must record the
/// completion marker exactly once.  A marker at the current contract version
/// is a complete no-op (`false`): the marker, including its `applied_at`
/// provenance, must not be rewritten.  Any other marker version is
/// unsupported and fails closed rather than being silently accepted or
/// downgraded.
pub(crate) fn migrate_narrative_application_rekey_v32(conn: &Connection) -> Result<bool> {
    match marker_version(conn)? {
        Some(version) if version == C2_ZB_CONTRACT_VERSION => return Ok(false),
        Some(version) => anyhow::bail!(
            "NEX_C2ZB_MARKER_UNSUPPORTED: marker contract version {version} is not current"
        ),
        None => {}
    }

    // Every project is planned before any C2-ZB write.  Keep the plans in
    // memory so a later project cannot be half-migrated when an earlier one
    // already changed its Edges.
    let project_ids = load_project_ids(conn)?;
    let mut plans = Vec::with_capacity(project_ids.len());
    for project_id in project_ids {
        let plan = plan_application_rekey(conn, &project_id)
            .with_context(|| format!("C2-ZB planning project '{project_id}'"))?;
        preflight_existing_application_edges(conn, &project_id)?;
        let (exact_history, attention_by_run) = preflight_plan(conn, &plan)?;
        plans.push(ProjectPreflight {
            plan,
            exact_history,
            attention_by_run,
        });
    }

    for preflight in &plans {
        if !preflight.plan.exact.is_empty() || !preflight.plan.fan_out.is_empty() {
            apply_project_plan(
                conn,
                &preflight.plan,
                &preflight.exact_history,
                &preflight.attention_by_run,
            )
            .with_context(|| format!("C2-ZB applying project '{}'", preflight.plan.project_id))?;
        }
    }

    // The schema owner records the marker after this data-only phase returns.
    // Keeping marker DML in `migrate.rs` makes the migration engine the sole
    // writer of schema_data_migrations while preserving one savepoint.
    Ok(true)
}

fn load_project_ids(conn: &Connection) -> Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT id FROM projects ORDER BY created_at ASC, id ASC")?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into);
    rows
}

fn marker_version(conn: &Connection) -> Result<Option<i64>> {
    conn.query_row(
        "SELECT contract_version FROM schema_data_migrations
          WHERE migration_id = ?1",
        [C2_ZB_MIGRATION_ID],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn preflight_plan(
    conn: &Connection,
    plan: &ApplicationRekeyPlan,
) -> Result<(
    BTreeMap<String, FindingHistorySnapshot>,
    BTreeMap<String, AttentionRehome>,
)> {
    ensure!(
        plan.invalid.is_empty(),
        "NEX_C2ZB_PREFLIGHT_INVALID: project '{}' has invalid legacy provenance: {:?}",
        plan.project_id,
        plan.invalid
    );
    ensure!(
        plan.collisions.is_empty(),
        "NEX_C2ZB_PREFLIGHT_COLLISION: project '{}' has Application target collisions: {:?}",
        plan.project_id,
        plan.collisions
    );
    let mut candidates_by_old_consumer: BTreeMap<String, Vec<&ApplicationRekeyCandidate>> =
        BTreeMap::new();
    let mut exact_history = BTreeMap::new();
    for candidate in plan.exact.iter().chain(
        plan.fan_out
            .iter()
            .flat_map(|fan_out| fan_out.candidates.iter()),
    ) {
        validate_planned_read_set(candidate)?;
        validate_stored_source_object_identity(&candidate.source_object_identity)?;
        validate_consumer_identity(RUN_CONSUMER_KIND, &candidate.run_id)?;
        validate_consumer_identity(APPLICATION_CONSUMER_KIND, &candidate.application_id)?;
        ensure!(
            candidate.old_consumer_kind == RUN_CONSUMER_KIND
                && candidate.old_consumer_key == candidate.run_id
                && candidate.new_consumer_kind == APPLICATION_CONSUMER_KIND
                && candidate.new_consumer_key == candidate.application_id,
            "NEX_C2ZB_PREFLIGHT_CONSUMER_COORDINATE_MISMATCH: project '{}' Edge '{}' has a planner coordinate outside the C2-ZB contract",
            plan.project_id,
            candidate.edge_id
        );
        let old_read_set_json = load_planned_old_edge_read_set(conn, plan, candidate)?;
        let old_read_token = read_set_token(&old_read_set_json)?;
        if candidate.mapping_kind == RekeyMappingKind::Exact {
            let planned_read_token = read_set_token(&candidate.planned_read_set_json)?;
            ensure!(
                old_read_token == planned_read_token,
                "NEX_C2ZB_PREFLIGHT_OLD_READ_SET_MISMATCH: project '{}' Run Edge '{}' does not carry the exact dependency token",
                plan.project_id,
                candidate.edge_id
            );
        }
        candidates_by_old_consumer
            .entry(candidate.run_id.clone())
            .or_default()
            .push(candidate);
        preflight_existing_target(conn, plan, candidate)?;
        let history = load_finding_history(
            conn,
            &plan.project_id,
            &candidate.run_id,
            &candidate.edge_id,
        )?;
        if candidate.mapping_kind == RekeyMappingKind::Exact {
            exact_history.insert(candidate.edge_id.clone(), history);
        } else {
            ensure!(
                history.observation_ids.is_empty()
                    && history.lifecycle_ids.is_empty()
                    && history.attention_keys.is_empty(),
                "NEX_C2ZB_PREFLIGHT_FANOUT_HISTORY: project '{}' Run Edge '{}' has Finding/Attention history",
                plan.project_id,
                candidate.edge_id
            );
        }
    }

    let mut attention_by_run = BTreeMap::new();
    for (run_id, candidates) in &candidates_by_old_consumer {
        if let Some(attention_rehome) = preflight_old_run_history(conn, plan, run_id, candidates)? {
            attention_by_run.insert(run_id.clone(), attention_rehome);
        }
    }

    Ok((exact_history, attention_by_run))
}

fn preflight_old_run_history(
    conn: &Connection,
    plan: &ApplicationRekeyPlan,
    run_id: &str,
    candidates: &[&ApplicationRekeyCandidate],
) -> Result<Option<AttentionRehome>> {
    let old_finding_key = finding_key(RUN_CONSUMER_KIND, run_id);
    let application_ids = candidates
        .iter()
        .map(|candidate| candidate.application_id.as_str())
        .collect::<BTreeSet<_>>();

    let mut observation_statement = conn.prepare(
        "SELECT id, edge_id, finding_identity
           FROM narrative_maintenance_finding_observations
          WHERE project_id = ?1 AND finding_key = ?2
          ORDER BY id",
    )?;
    let observations =
        observation_statement.query_map(params![plan.project_id, old_finding_key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
    for row in observations {
        let (observation_id, edge_id, row_identity) = row?;
        let edge_id = edge_id.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_C2ZB_PREFLIGHT_OBSERVATION_EDGE_MISSING: project '{}' Observation '{}' has old Run key but no Edge identity",
                plan.project_id,
                observation_id
            )
        })?;
        let row_identity = row_identity.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_C2ZB_PREFLIGHT_OBSERVATION_IDENTITY_MISSING: project '{}' Observation '{}' has old Run key but no finding identity",
                plan.project_id,
                observation_id
            )
        })?;
        let candidate = candidates
            .iter()
            .find(|candidate| candidate.edge_id == edge_id)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_C2ZB_PREFLIGHT_OBSERVATION_EDGE_UNATTRIBUTED: project '{}' Observation '{}' does not name a planned old Edge",
                    plan.project_id,
                    observation_id
                )
            })?;
        let expected_identity =
            stable_finding_identity(FINDING_RULE_ID, FINDING_RULE_VERSION, &candidate.edge_id)?;
        ensure!(
            row_identity == expected_identity,
            "NEX_C2ZB_PREFLIGHT_OBSERVATION_IDENTITY_CONFLICT: project '{}' Observation '{}' has a different finding identity",
            plan.project_id,
            observation_id
        );
        ensure!(
            candidate.mapping_kind == RekeyMappingKind::Exact,
            "NEX_C2ZB_PREFLIGHT_FANOUT_HISTORY: project '{}' Run Edge '{}' has Observation history",
            plan.project_id,
            candidate.edge_id
        );
    }

    let mut lifecycle_statement = conn.prepare(
        "SELECT id, finding_identity
           FROM narrative_maintenance_finding_lifecycle
          WHERE project_id = ?1 AND finding_key = ?2
          ORDER BY id",
    )?;
    let lifecycle = lifecycle_statement
        .query_map(params![plan.project_id, old_finding_key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
    for row in lifecycle {
        let (lifecycle_id, row_identity) = row?;
        let candidate = candidate_for_finding_identity(plan, candidates, &row_identity)?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_C2ZB_PREFLIGHT_LIFECYCLE_IDENTITY_UNATTRIBUTED: project '{}' Lifecycle '{}' does not name a planned old Edge",
                    plan.project_id,
                    lifecycle_id
                )
            })?;
        ensure!(
            candidate.mapping_kind == RekeyMappingKind::Exact,
            "NEX_C2ZB_PREFLIGHT_FANOUT_HISTORY: project '{}' Run Edge '{}' has Lifecycle history",
            plan.project_id,
            candidate.edge_id
        );
    }

    let attention: Option<Option<String>> = conn
        .query_row(
            "SELECT finding_identity
               FROM narrative_maintenance_attention
              WHERE project_id = ?1 AND finding_key = ?2",
            params![plan.project_id, old_finding_key],
            |row| row.get(0),
        )
        .optional()?;
    let Some(attention_identity) = attention else {
        return Ok(None);
    };
    let candidate = if let Some(attention_identity) = attention_identity {
        candidate_for_finding_identity(plan, candidates, &attention_identity)?.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_C2ZB_PREFLIGHT_ATTENTION_IDENTITY_UNATTRIBUTED: project '{}' Run '{}' Attention identity does not name a planned old Edge",
                plan.project_id,
                run_id
            )
        })?
    } else {
        ensure!(
            application_ids.len() == 1,
            "NEX_C2ZB_PREFLIGHT_ATTENTION_AMBIGUOUS: project '{}' Run '{}' Attention without identity maps to multiple Applications",
            plan.project_id,
            run_id
        );
        candidates.first().ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_C2ZB_PREFLIGHT_ATTENTION_CANDIDATE_MISSING: project '{}' Run '{}' has Attention without a planned mapping",
                plan.project_id,
                run_id
            )
        })?
    };
    ensure!(
        candidate.mapping_kind == RekeyMappingKind::Exact,
        "NEX_C2ZB_PREFLIGHT_FANOUT_HISTORY: project '{}' Run Edge '{}' has Attention history",
        plan.project_id,
        candidate.edge_id
    );
    let application_id = candidate.application_id.as_str();
    let new_finding_key = finding_key(APPLICATION_CONSUMER_KIND, application_id);
    ensure!(
        !attention_exists(conn, &plan.project_id, &new_finding_key)?,
        "NEX_C2ZB_PREFLIGHT_ATTENTION_TARGET_CONFLICT: project '{}' already has Application Attention '{}'",
        plan.project_id,
        new_finding_key
    );
    Ok(Some(AttentionRehome {
        application_id: application_id.to_string(),
        expected_count: 1,
    }))
}

fn candidate_for_finding_identity<'a>(
    plan: &ApplicationRekeyPlan,
    candidates: &[&'a ApplicationRekeyCandidate],
    finding_identity: &str,
) -> Result<Option<&'a ApplicationRekeyCandidate>> {
    let mut matching = Vec::new();
    for candidate in candidates {
        let candidate_identity =
            stable_finding_identity(FINDING_RULE_ID, FINDING_RULE_VERSION, &candidate.edge_id)?;
        if candidate_identity == finding_identity {
            matching.push(*candidate);
        }
    }
    ensure!(
        matching.len() <= 1,
        "NEX_C2ZB_PREFLIGHT_FINDING_IDENTITY_DUPLICATE: project '{}' finding identity '{}' maps to multiple planned Edges",
        plan.project_id,
        finding_identity
    );
    Ok(matching.into_iter().next())
}

fn preflight_existing_application_edges(conn: &Connection, project_id: &str) -> Result<()> {
    let mut statement = conn.prepare(
        "SELECT e.id, e.consumer_key, e.source_object_identity, e.read_set_json,
                e.owning_run_id, r.project_id
           FROM narrative_dependency_edges e
           LEFT JOIN narrative_extraction_runs r ON r.id = e.owning_run_id
          WHERE e.project_id = ?1 AND e.consumer_kind = ?2
          ORDER BY e.id",
    )?;
    let rows = statement.query_map(params![project_id, APPLICATION_CONSUMER_KIND], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;
    for row in rows {
        let (edge_id, application_id, source, read_set_json, owning_run_id, owning_project_id) =
            row?;
        validate_consumer_identity(APPLICATION_CONSUMER_KIND, &application_id)?;
        ensure!(
            !source.trim().is_empty() && source.trim() == source,
            "NEX_C2ZB_PREFLIGHT_APPLICATION_EDGE_INVALID: Edge '{}' has an empty identity",
            edge_id
        );
        validate_stored_source_object_identity(&source).with_context(|| {
            format!(
                "NEX_C2ZB_PREFLIGHT_APPLICATION_EDGE_SOURCE_INVALID: Edge '{edge_id}' has malformed Source identity"
            )
        })?;
        validate_read_set_json(&read_set_json, &edge_id)?;
        let owner = owning_run_id.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_C2ZB_PREFLIGHT_APPLICATION_EDGE_OWNER_MISSING: Edge '{}' has no owning Run",
                edge_id
            )
        })?;
        validate_consumer_identity(RUN_CONSUMER_KIND, &owner)?;
        ensure!(
            owning_project_id.as_deref() == Some(project_id),
            "NEX_C2ZB_PREFLIGHT_APPLICATION_EDGE_OWNER_FOREIGN: Edge '{}' owner '{}' is not in project '{}'",
            edge_id,
            owner,
            project_id
        );
        preflight_existing_application_provenance(
            conn,
            project_id,
            &edge_id,
            &application_id,
            &source,
            &read_set_json,
        )?;
    }
    Ok(())
}

fn preflight_existing_application_provenance(
    conn: &Connection,
    project_id: &str,
    edge_id: &str,
    application_id: &str,
    source_object_identity: &str,
    read_set_json: &str,
) -> Result<()> {
    let application_commit_project: Option<String> = conn
        .query_row(
            "SELECT c.project_id
               FROM narrative_proposal_applications a
               JOIN narrative_apply_commits c ON c.id = a.commit_id
              WHERE a.id = ?1",
            [application_id],
            |row| row.get(0),
        )
        .optional()?;
    let application_commit_project = application_commit_project.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_C2ZB_PREFLIGHT_APPLICATION_PROVENANCE_MISSING: Edge '{}' Application '{}' has no durable ApplyCommit",
            edge_id,
            application_id
        )
    })?;
    ensure!(
        application_commit_project == project_id,
        "NEX_C2ZB_PREFLIGHT_APPLICATION_PROJECT_MISMATCH: Edge '{}' Application '{}' belongs to project '{}' rather than '{}'",
        edge_id,
        application_id,
        application_commit_project,
        project_id
    );

    let observed_token = read_set_token(read_set_json)?;
    let mut statement = conn.prepare(
        "SELECT source_kind, source_key, observed_revision_token
           FROM narrative_projection_dependencies
          WHERE application_id = ?1
          ORDER BY source_kind ASC, source_key ASC",
    )?;
    let rows = statement.query_map([application_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut exact_matches = 0usize;
    for row in rows {
        let (source_kind, source_key, dependency_token) = row?;
        let dependency_source = canonical_source_object_identity(&source_kind, &source_key)
            .with_context(|| {
                format!(
                    "NEX_C2ZB_PREFLIGHT_APPLICATION_DEPENDENCY_SOURCE_INVALID: Edge '{}' Application '{}' has malformed projection Source",
                    edge_id, application_id
                )
            })?;
        if dependency_source == source_object_identity && dependency_token == observed_token {
            exact_matches += 1;
        }
    }
    ensure!(
        exact_matches == 1,
        "NEX_C2ZB_PREFLIGHT_APPLICATION_DEPENDENCY_MISMATCH: Edge '{}' Application '{}' has {} exact projection dependency matches for Source/read set",
        edge_id,
        application_id,
        exact_matches
    );
    Ok(())
}

fn preflight_existing_target(
    conn: &Connection,
    plan: &ApplicationRekeyPlan,
    candidate: &ApplicationRekeyCandidate,
) -> Result<()> {
    let target = load_existing_target(
        conn,
        &plan.project_id,
        &candidate.application_id,
        &candidate.source_object_identity,
    )?;
    let Some(target) = target else {
        return Ok(());
    };
    ensure!(
        target.read_set_json == candidate.planned_read_set_json,
        "NEX_C2ZB_PREFLIGHT_TARGET_READ_SET_MISMATCH: Application '{}' Source '{}' has read set '{}' but planned '{}'",
        candidate.application_id,
        candidate.source_object_identity,
        target.read_set_json,
        candidate.planned_read_set_json
    );
    ensure!(
        target.owning_run_id.is_some()
            && target.owning_project_id.as_deref() == Some(plan.project_id.as_str()),
        "NEX_C2ZB_PREFLIGHT_TARGET_OWNER_MISMATCH: Application '{}' Source '{}' does not name a valid same-project owner Run",
        candidate.application_id,
        candidate.source_object_identity
    );
    if target.id != candidate.edge_id {
        let history = load_finding_history(
            conn,
            &plan.project_id,
            &candidate.run_id,
            &candidate.edge_id,
        )?;
        ensure!(
            history.observation_ids.is_empty()
                && history.lifecycle_ids.is_empty()
                && history.attention_keys.is_empty()
                && !old_run_has_null_identity_attention(
                    conn,
                    &plan.project_id,
                    &candidate.run_id,
                )?,
            "NEX_C2ZB_PREFLIGHT_TARGET_IDENTITY_COLLISION: old Edge '{}' has history but target Edge '{}' differs",
            candidate.edge_id,
            target.id
        );
    }
    Ok(())
}

/// A NULL-identity Attention under the old Run key cannot be assigned to one
/// of several exact Edges. Treat it as shared/ambiguous history when checking
/// whether an existing Application target may replace a different old Edge.
fn old_run_has_null_identity_attention(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> Result<bool> {
    let old_finding_key = finding_key(RUN_CONSUMER_KIND, run_id);
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1
              FROM narrative_maintenance_attention
             WHERE project_id = ?1 AND finding_key = ?2 AND finding_identity IS NULL
        )",
        params![project_id, old_finding_key],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn validate_planned_read_set(candidate: &ApplicationRekeyCandidate) -> Result<()> {
    validate_read_set_json(&candidate.planned_read_set_json, &candidate.application_id)
}

fn validate_read_set_json(read_set_json: &str, coordinate: &str) -> Result<()> {
    let values: Vec<Value> =
        serde_json::from_str(read_set_json).context("C2-ZB read set is not JSON")?;
    ensure!(
        values.len() == 1
            && values[0]
                .as_str()
                .is_some_and(|token| !token.trim().is_empty() && token == token.trim()),
        "NEX_C2ZB_PREFLIGHT_READ_SET_INVALID: Edge/Application '{}' read set must contain one non-empty, unpadded observed token",
        coordinate
    );
    Ok(())
}

fn read_set_token(read_set_json: &str) -> Result<String> {
    validate_read_set_json(read_set_json, "C2-ZB")?;
    let values: Vec<Value> = serde_json::from_str(read_set_json)?;
    values[0]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("C2-ZB read set token is not a string"))
}

fn load_planned_old_edge_read_set(
    conn: &Connection,
    plan: &ApplicationRekeyPlan,
    candidate: &ApplicationRekeyCandidate,
) -> Result<String> {
    let row: Option<(String, String, String, Option<String>)> = conn
        .query_row(
            "SELECT source_object_identity, consumer_key, read_set_json, owning_run_id
               FROM narrative_dependency_edges
              WHERE id = ?1 AND project_id = ?2 AND consumer_kind = ?3",
            params![candidate.edge_id, plan.project_id, RUN_CONSUMER_KIND],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let (source_object_identity, consumer_key, read_set_json, owning_run_id) = row
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_C2ZB_PREFLIGHT_OLD_EDGE_MISSING: project '{}' Run Edge '{}' disappeared before preflight",
                plan.project_id,
                candidate.edge_id
            )
        })?;
    ensure!(
        source_object_identity == candidate.source_object_identity
            && consumer_key == candidate.run_id
            && owning_run_id.as_deref() == Some(candidate.run_id.as_str()),
        "NEX_C2ZB_PREFLIGHT_OLD_EDGE_COORDINATE_MISMATCH: project '{}' Run Edge '{}' does not match the planned source/owner coordinates",
        plan.project_id,
        candidate.edge_id
    );
    Ok(read_set_json)
}

fn load_existing_target(
    conn: &Connection,
    project_id: &str,
    application_id: &str,
    source_object_identity: &str,
) -> Result<Option<ExistingApplicationEdge>> {
    conn.query_row(
        "SELECT e.id, e.read_set_json, e.owning_run_id, r.project_id
           FROM narrative_dependency_edges e
           LEFT JOIN narrative_extraction_runs r ON r.id = e.owning_run_id
          WHERE e.project_id = ?1 AND e.consumer_kind = ?2
            AND e.consumer_key = ?3 AND e.source_object_identity = ?4",
        params![
            project_id,
            APPLICATION_CONSUMER_KIND,
            application_id,
            source_object_identity
        ],
        |row| {
            Ok(ExistingApplicationEdge {
                id: row.get(0)?,
                read_set_json: row.get(1)?,
                owning_run_id: row.get(2)?,
                owning_project_id: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn load_finding_history(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    edge_id: &str,
) -> Result<FindingHistorySnapshot> {
    let old_finding_key = finding_key(RUN_CONSUMER_KIND, run_id);
    let finding_identity = stable_finding_identity(FINDING_RULE_ID, FINDING_RULE_VERSION, edge_id)?;
    let mut observation_statement = conn.prepare(
        "SELECT id, edge_id, finding_key, finding_identity
           FROM narrative_maintenance_finding_observations
          WHERE project_id = ?1 AND (edge_id = ?2 OR finding_identity = ?3)
          ORDER BY id",
    )?;
    let observations =
        observation_statement.query_map(params![project_id, edge_id, finding_identity], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
    let mut observation_ids = Vec::new();
    for row in observations {
        let (id, row_edge_id, row_finding_key, row_finding_identity) = row?;
        ensure!(
            row_edge_id.as_deref() == Some(edge_id)
                && row_finding_identity.as_deref() == Some(finding_identity.as_str()),
            "NEX_C2ZB_PREFLIGHT_OBSERVATION_IDENTITY_INCOMPLETE: project '{}' Observation '{}' does not carry the exact old Edge and finding identity",
            project_id,
            id
        );
        ensure!(
            row_finding_key == old_finding_key,
            "NEX_C2ZB_PREFLIGHT_OBSERVATION_KEY_CONFLICT: project '{}' Observation '{}' does not use the old finding key",
            project_id,
            id
        );
        observation_ids.push(id);
    }

    let mut lifecycle_statement = conn.prepare(
        "SELECT id, finding_key, finding_identity
           FROM narrative_maintenance_finding_lifecycle
          WHERE project_id = ?1 AND finding_identity = ?2
          ORDER BY id",
    )?;
    let lifecycle =
        lifecycle_statement.query_map(params![project_id, finding_identity], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
    let mut lifecycle_ids = Vec::new();
    for row in lifecycle {
        let (id, row_finding_key, row_finding_identity) = row?;
        ensure!(
            row_finding_identity == finding_identity && row_finding_key == old_finding_key,
            "NEX_C2ZB_PREFLIGHT_LIFECYCLE_HISTORY_INVALID: project '{}' Lifecycle '{}' is not canonical old Edge history",
            project_id,
            id
        );
        lifecycle_ids.push(id);
    }

    let mut attention_statement = conn.prepare(
        "SELECT finding_key, finding_identity
           FROM narrative_maintenance_attention
          WHERE project_id = ?1 AND finding_identity = ?2
          ORDER BY finding_key",
    )?;
    let attention = attention_statement
        .query_map(params![project_id, finding_identity], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
    let mut attention_keys = Vec::new();
    for row in attention {
        let (row_finding_key, row_finding_identity) = row?;
        ensure!(
            row_finding_identity.as_deref() == Some(finding_identity.as_str())
                && row_finding_key == old_finding_key,
            "NEX_C2ZB_PREFLIGHT_ATTENTION_HISTORY_INVALID: project '{}' Attention is not canonical old Edge history",
            project_id
        );
        attention_keys.push(row_finding_key);
    }

    Ok(FindingHistorySnapshot {
        observation_ids,
        lifecycle_ids,
        attention_keys,
    })
}

fn attention_exists(conn: &Connection, project_id: &str, finding_key: &str) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM narrative_maintenance_attention
             WHERE project_id = ?1 AND finding_key = ?2
        )",
        params![project_id, finding_key],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn finding_key(consumer_kind: &str, consumer_key: &str) -> String {
    format!("{consumer_kind}:{consumer_key}")
}

fn apply_project_plan(
    conn: &Connection,
    plan: &ApplicationRekeyPlan,
    exact_history: &BTreeMap<String, FindingHistorySnapshot>,
    attention_by_run: &BTreeMap<String, AttentionRehome>,
) -> Result<()> {
    for candidate in &plan.exact {
        let history = exact_history.get(&candidate.edge_id).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_C2ZB_APPLY_HISTORY_SNAPSHOT_MISSING: Edge '{}' was not preflighted",
                candidate.edge_id
            )
        })?;
        apply_exact_candidate(conn, plan, candidate, history)?;
    }
    for fan_out in &plan.fan_out {
        apply_fan_out(conn, plan, fan_out)?;
    }
    for (run_id, attention_rehome) in attention_by_run {
        let old_key = finding_key(RUN_CONSUMER_KIND, run_id);
        let new_key = finding_key(APPLICATION_CONSUMER_KIND, &attention_rehome.application_id);
        let updated = conn.execute(
            "UPDATE narrative_maintenance_attention
                SET finding_key = ?1
              WHERE project_id = ?2 AND finding_key = ?3",
            params![new_key, plan.project_id, old_key],
        )?;
        ensure!(
            updated == attention_rehome.expected_count,
            "NEX_C2ZB_APPLY_ATTENTION_HISTORY_MISMATCH: expected one old Attention row for Run '{}'",
            run_id
        );
    }
    if !plan.exact.is_empty() || !plan.fan_out.is_empty() {
        create_epoch_in_tx(conn, &plan.project_id, "migration", None)?;
    }
    Ok(())
}

fn apply_exact_candidate(
    conn: &Connection,
    plan: &ApplicationRekeyPlan,
    candidate: &ApplicationRekeyCandidate,
    history: &FindingHistorySnapshot,
) -> Result<()> {
    let target = load_existing_target(
        conn,
        &plan.project_id,
        &candidate.application_id,
        &candidate.source_object_identity,
    )?;
    delete_derived_state(conn, plan, candidate, target.as_ref())?;
    let old_key = finding_key(RUN_CONSUMER_KIND, &candidate.run_id);
    let new_key = finding_key(APPLICATION_CONSUMER_KIND, &candidate.application_id);
    rehome_finding_history(conn, plan, candidate, history, &old_key, &new_key)?;

    if let Some(target) = target {
        ensure!(
            target.id != candidate.edge_id,
            "NEX_C2ZB_APPLY_TARGET_EQUALS_OLD: target Edge '{}' unexpectedly equals Run Edge '{}'",
            target.id,
            candidate.edge_id
        );
        conn.execute(
            "DELETE FROM narrative_dependency_edges WHERE id = ?1",
            [candidate.edge_id.as_str()],
        )?;
    } else {
        let updated = conn.execute(
            "UPDATE narrative_dependency_edges
                SET consumer_kind = ?1, consumer_key = ?2,
                    read_set_json = ?3, owning_run_id = ?4
              WHERE id = ?5 AND project_id = ?6
                AND consumer_kind = ?7 AND consumer_key = ?8",
            params![
                APPLICATION_CONSUMER_KIND,
                candidate.application_id,
                candidate.planned_read_set_json,
                candidate.run_id,
                candidate.edge_id,
                plan.project_id,
                RUN_CONSUMER_KIND,
                candidate.run_id,
            ],
        )?;
        ensure!(
            updated == 1,
            "NEX_C2ZB_APPLY_OLD_EDGE_MISSING: Run Edge '{}' disappeared during migration",
            candidate.edge_id
        );
    }
    delete_consumer_freshness(conn, plan, candidate)?;
    Ok(())
}

fn apply_fan_out(
    conn: &Connection,
    plan: &ApplicationRekeyPlan,
    fan_out: &ApplicationRekeyFanOut,
) -> Result<()> {
    let metadata = load_edge_metadata(conn, plan, &fan_out.edge_id)?;
    for candidate in &fan_out.candidates {
        let target = load_existing_target(
            conn,
            &plan.project_id,
            &candidate.application_id,
            &candidate.source_object_identity,
        )?;
        delete_derived_state(conn, plan, candidate, target.as_ref())?;
        if target.is_none() {
            let edge_id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key,
                     source_object_identity, read_set_json,
                     generated_by_transaction_id, created_at, owning_run_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    edge_id,
                    metadata.project_id,
                    APPLICATION_CONSUMER_KIND,
                    candidate.application_id,
                    metadata.source_object_identity,
                    candidate.planned_read_set_json,
                    metadata.generated_by_transaction_id,
                    metadata.created_at,
                    candidate.run_id,
                ],
            )?;
        }
    }
    conn.execute(
        "DELETE FROM narrative_dependency_edge_states WHERE edge_id = ?1",
        [fan_out.edge_id.as_str()],
    )?;
    conn.execute(
        "DELETE FROM narrative_dependency_edges WHERE id = ?1",
        [fan_out.edge_id.as_str()],
    )?;
    for candidate in &fan_out.candidates {
        delete_consumer_freshness(conn, plan, candidate)?;
    }
    Ok(())
}

fn load_edge_metadata(
    conn: &Connection,
    plan: &ApplicationRekeyPlan,
    edge_id: &str,
) -> Result<EdgeMetadata> {
    conn.query_row(
        "SELECT project_id, source_object_identity, generated_by_transaction_id, created_at
           FROM narrative_dependency_edges
          WHERE id = ?1 AND project_id = ?2 AND consumer_kind = ?3",
        params![edge_id, plan.project_id, RUN_CONSUMER_KIND],
        |row| {
            Ok(EdgeMetadata {
                project_id: row.get(0)?,
                source_object_identity: row.get(1)?,
                generated_by_transaction_id: row.get(2)?,
                created_at: row.get(3)?,
            })
        },
    )
    .map_err(Into::into)
}

fn rehome_finding_history(
    conn: &Connection,
    plan: &ApplicationRekeyPlan,
    candidate: &ApplicationRekeyCandidate,
    history: &FindingHistorySnapshot,
    old_key: &str,
    new_key: &str,
) -> Result<()> {
    if candidate.mapping_kind != RekeyMappingKind::Exact {
        return Ok(());
    }
    for observation_id in &history.observation_ids {
        let updated = conn.execute(
            "UPDATE narrative_maintenance_finding_observations
                SET finding_key = ?1
              WHERE project_id = ?2 AND id = ?3 AND finding_key = ?4",
            params![new_key, plan.project_id, observation_id, old_key],
        )?;
        ensure!(
            updated == 1,
            "NEX_C2ZB_APPLY_OBSERVATION_HISTORY_MISMATCH: Observation '{}' changed after preflight",
            observation_id
        );
    }
    for lifecycle_id in &history.lifecycle_ids {
        let updated = conn.execute(
            "UPDATE narrative_maintenance_finding_lifecycle
                SET finding_key = ?1
              WHERE project_id = ?2 AND id = ?3 AND finding_key = ?4",
            params![new_key, plan.project_id, lifecycle_id, old_key],
        )?;
        ensure!(
            updated == 1,
            "NEX_C2ZB_APPLY_LIFECYCLE_HISTORY_MISMATCH: Lifecycle '{}' changed after preflight",
            lifecycle_id
        );
    }
    Ok(())
}

fn delete_derived_state(
    conn: &Connection,
    plan: &ApplicationRekeyPlan,
    candidate: &ApplicationRekeyCandidate,
    target: Option<&ExistingApplicationEdge>,
) -> Result<()> {
    conn.execute(
        "DELETE FROM narrative_dependency_edge_states WHERE edge_id = ?1",
        [candidate.edge_id.as_str()],
    )?;
    if let Some(target) = target {
        conn.execute(
            "DELETE FROM narrative_dependency_edge_states WHERE edge_id = ?1",
            [target.id.as_str()],
        )?;
    }
    delete_consumer_freshness(conn, plan, candidate)
}

fn delete_consumer_freshness(
    conn: &Connection,
    plan: &ApplicationRekeyPlan,
    candidate: &ApplicationRekeyCandidate,
) -> Result<()> {
    conn.execute(
        "DELETE FROM narrative_consumer_freshness
          WHERE project_id = ?1 AND consumer_kind = ?2
            AND consumer_key = ?3",
        params![plan.project_id, RUN_CONSUMER_KIND, candidate.run_id],
    )?;
    conn.execute(
        "DELETE FROM narrative_consumer_freshness
          WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
        params![
            plan.project_id,
            APPLICATION_CONSUMER_KIND,
            candidate.application_id
        ],
    )?;
    Ok(())
}

fn _assert_compile_time_imports() {
    // Keep the planner's public mapping type in the migration module's API
    // surface; the function is optimized away and exists only to make a
    // future planner rename fail at compile time rather than silently
    // reintroducing a second mapping authority.
    let _ = std::mem::size_of::<ApplicationRekeyCandidate>();
    let _ = std::mem::size_of::<ApplicationRekeyFanOut>();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(read_set_json: &str) -> ApplicationRekeyCandidate {
        ApplicationRekeyCandidate {
            edge_id: "edge-read-set".to_string(),
            run_id: "run-read-set".to_string(),
            application_id: "application-read-set".to_string(),
            old_consumer_kind: RUN_CONSUMER_KIND.to_string(),
            old_consumer_key: "run-read-set".to_string(),
            new_consumer_kind: APPLICATION_CONSUMER_KIND.to_string(),
            new_consumer_key: "application-read-set".to_string(),
            source_object_identity: "project:scene:scene-read-set".to_string(),
            planned_read_set_json: read_set_json.to_string(),
            mapping_kind: RekeyMappingKind::Exact,
        }
    }

    #[test]
    fn planned_read_set_requires_one_nonempty_unpadded_token() {
        for read_set_json in [
            r#"[]"#,
            r#"[null]"#,
            r#"[""]"#,
            r#"[" padded"]"#,
            r#"["padded "]"#,
        ] {
            assert!(
                validate_planned_read_set(&candidate(read_set_json)).is_err(),
                "malformed read set {read_set_json} must fail closed"
            );
        }
        validate_planned_read_set(&candidate(r#"["token"]"#))
            .expect("one canonical observed token is valid");
    }
}
