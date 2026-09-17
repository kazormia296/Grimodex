//! Opt-in, file-backed NIR-1 B capacity fixtures.
//!
//! The builder is a diagnostic support tool.  It creates the catalog through
//! the existing schema, then creates every measured typed Revision through
//! the Native A2 writer and Human Decision writer.  It never adds a table,
//! authority, consumer, or Graph generation.  The resulting database is
//! closed and WAL-checkpointed before the caller is allowed to measure it.

use anyhow::{ensure, Context, Result};
use grimodex_core::narrative_nir1::{
    EntityInput, EntityRelationBundle, EvidenceInput, GraphEdgeInput, ScopeBinding, ScopeValue,
    ENTITY_RELATION_PRODUCER,
};
use grimodex_core::narrative_scene_scope::NarrativeSceneScopeRegistryV1;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::Database;

use super::nir1_capacity_diagnostics::{
    measure_capacity, read_persisted_verify_report_records, CapacityObservation,
};
use super::nir1_entity_relation::create_nir1_entity_relation_revision;
use super::project_scope_authority::load_live_project_scope_authority;
use super::publish_runtime::publish_complete_runless_freshness_in_tx;
use super::semantic_epoch::create_epoch_in_tx;
use super::{
    ensure_scene_scope_binding_in_tx, narrative_extraction_append_human_decision,
    narrative_extraction_create_run, read_narrative_scene_scope,
    update_narrative_scene_scope_registry, AppendDecisionPayload, BuildAction, CreateRunPayload,
    EdgeObservation, EvidenceFreshness, FindingReasonCode,
    NarrativeSceneScopeRegistryUpdatePayload, Nir1EntityRelationRevisionRequest,
    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
};

pub const NIR1_CAPACITY_FIXTURE_SCHEMA_VERSION: &str = "nir1-capacity/1";
pub const NIR1_CAPACITY_FIXTURE_PROJECT_ID: &str = "nir1-capacity-fixture-project";
pub const NIR1_CAPACITY_FIXTURE_SCENE_ID: &str = "nir1-capacity-scene";
const NIR1_CAPACITY_SCOPE_DRIFT_SCENE_ID: &str = "nir1-capacity-scope-drift-scene";
const NIR1_CAPACITY_RUN_ID: &str = "nir1-capacity-fixture-run";
const NIR1_CAPACITY_UPDATED_AT: &str = "2026-09-17T00:00:00Z";
const NIR1_CAPACITY_DRIFTED_AT: &str = "2026-09-18T00:00:00Z";
const NIR1_CAPACITY_SOURCE_DRIFTED_AT: &str = "2026-09-19T00:00:00Z";
const NIR1_CAPACITY_FRESHNESS_STALE_AT: &str = "2026-09-18T00:00:00.000Z";
const MAX_REVISION_MATERIAL_RECORDS: usize = 511;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapacityManifest {
    schema_version: String,
    diagnostic_only: bool,
    fixtures: Vec<CapacityFixtureSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapacityFixtureSpec {
    id: String,
    qualified_materials: Option<usize>,
    qualified_revisions: Option<usize>,
    ineligible_candidates: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureExpectedShape {
    pub qualified_materials: Option<usize>,
    pub qualified_revisions: Option<usize>,
    pub ineligible_candidates: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureCheckpoint {
    pub database_path: String,
    pub wal_bytes: u64,
    pub shm_bytes: u64,
    pub reopened_read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityFixtureBuildResult {
    pub schema_version: &'static str,
    pub diagnostic_only: bool,
    pub case_id: String,
    pub database_path: String,
    pub expected: FixtureExpectedShape,
    pub observed: CapacityObservation,
    /// UTF-8 bytes in the catalog's live `name` and `summary` columns after
    /// all fixture mutations.  The read-only capacity probe intentionally
    /// leaves live Source bytes unmeasured; the fixture builder reports this
    /// exact seeded input size separately rather than treating it as a probe
    /// observation.
    pub seeded_live_source_bytes: u64,
    /// Number of real report entries persisted in the completed dependency
    /// Verify outcome. The diagnostic intentionally does not synthesize
    /// finding-observation rows merely to make this count non-zero.
    pub persisted_verify_report_records: Option<u64>,
    pub category_counts: BTreeMap<String, usize>,
    pub checkpoint: FixtureCheckpoint,
}

#[derive(Debug, Clone)]
struct RevisionPlan {
    index: usize,
    entity_ids: Vec<String>,
    relation_ids: Vec<String>,
    scene_id: String,
    category: Option<&'static str>,
    byte_heavy: bool,
    shared_materials: bool,
}

#[derive(Debug, Clone)]
struct CatalogEntry {
    id: String,
    summary: String,
}

#[derive(Debug, Clone)]
struct CatalogRelation {
    id: String,
    from_id: String,
    to_id: String,
}

/// Create one exact manifest case.  The output path must not already exist;
/// this makes accidental replacement of a measured source database fail
/// closed.
pub fn build_fixture_from_manifest(
    manifest_path: &Path,
    case_id: &str,
    output_path: &Path,
) -> Result<CapacityFixtureBuildResult> {
    ensure!(
        !case_id.trim().is_empty(),
        "capacity fixture case id is required"
    );
    ensure!(
        !output_path.exists(),
        "capacity fixture output already exists: {}",
        output_path.display()
    );
    let manifest: CapacityManifest = serde_json::from_str(
        &fs::read_to_string(manifest_path)
            .with_context(|| format!("read capacity manifest {}", manifest_path.display()))?,
    )?;
    ensure!(
        manifest.schema_version == NIR1_CAPACITY_FIXTURE_SCHEMA_VERSION,
        "unsupported capacity manifest schema: {}",
        manifest.schema_version
    );
    ensure!(
        manifest.diagnostic_only,
        "capacity fixture manifest must be diagnostic-only"
    );
    let spec = manifest
        .fixtures
        .into_iter()
        .find(|fixture| fixture.id == case_id)
        .with_context(|| format!("capacity fixture case not found: {case_id}"))?;
    let expected = FixtureExpectedShape {
        qualified_materials: spec.qualified_materials,
        qualified_revisions: spec.qualified_revisions,
        ineligible_candidates: spec.ineligible_candidates,
    };
    let plans = plan_case(case_id, &expected)?;
    let output_path = output_path.to_path_buf();
    if let Some(parent) = output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("create fixture output directory {}", parent.display()))?;
    }

    let mut category_counts = BTreeMap::new();
    {
        let db = Database::new(&output_path)
            .with_context(|| format!("open fixture output {}", output_path.display()))?;
        db.migrate()?;
        let catalog = catalog_for_plans(&plans);
        seed_catalog_and_authorities(&db, &catalog.entries, &catalog.relations)?;
        create_typed_run(&db, NIR1_CAPACITY_RUN_ID, "capacity-initial")?;

        let mut source_drift_ids = Vec::new();
        let mut stale_revision_ids = Vec::new();
        let mut approved_scope_drift = false;
        let mut revision_ordinal = 0usize;
        let has_ineligible = expected.ineligible_candidates.unwrap_or(0) > 0;
        // Scope drift changes the shared project Scope authority. Create and
        // approve those candidates before the mutation, then create every
        // other invalid candidate against the new live authority. This keeps
        // a stale-Freshness candidate's Scope Source token live while still
        // preserving a real Scope-drift candidate in the same fixture.
        for plan in plans
            .iter()
            .filter(|plan| plan.category == Some("scope-drift"))
        {
            create_and_record_invalid_plan(
                &db,
                plan,
                NIR1_CAPACITY_RUN_ID,
                &mut revision_ordinal,
                &mut category_counts,
                &mut source_drift_ids,
                &mut stale_revision_ids,
            )?;
            approved_scope_drift = true;
        }
        if approved_scope_drift {
            mutate_scope_registry(&db)?;
            // The real registry writer appends a canonical Feed event. Run
            // the existing bounded Freshness owner before adding the other D
            // revisions so the fixture represents a maintained workspace;
            // directly advancing the cursor would bypass that authority.
            let _ = super::run_incremental_freshness_cycle(&db)?;
        }
        for plan in plans
            .iter()
            .filter(|plan| plan.category.is_some() && plan.category != Some("scope-drift"))
        {
            create_and_record_invalid_plan(
                &db,
                plan,
                NIR1_CAPACITY_RUN_ID,
                &mut revision_ordinal,
                &mut category_counts,
                &mut source_drift_ids,
                &mut stale_revision_ids,
            )?;
        }

        if !source_drift_ids.is_empty() {
            mutate_source_drift_candidates(&db, &source_drift_ids)?;
        }
        if !stale_revision_ids.is_empty() {
            seed_stale_freshness_candidates(&db, &stale_revision_ids)?;
        }
        let report_heavy = case_id == "D2064/report-heavy";
        if report_heavy {
            // The missing Source state is real: typed revisions were written
            // and approved first, then the existing catalog visibility field
            // was changed.  Verify consumes those durable Edges and persists
            // its normal report/findings; no synthetic report rows are added.
            hide_report_heavy_sources(&db)?;
            let outcome =
                super::run_dependency_verify_for_project(&db, NIR1_CAPACITY_FIXTURE_PROJECT_ID)?;
            ensure!(
                !outcome.report.edge_ids_with_missing_source.is_empty(),
                "report-heavy fixture did not produce a real missing-Source report"
            );
        }

        let qualified_plans = plans.iter().filter(|plan| plan.category.is_none());
        if has_ineligible {
            // Keep the invalid candidates and the final qualified candidates
            // in separate typed runs, but in the same semantic epoch.  An
            // epoch rotation intentionally invalidates canonical freshness
            // for every revision in the project, which would make this mixed
            // capacity fixture unable to demonstrate that only the D cases
            // are rejected.
            create_typed_run(&db, "nir1-capacity-qualified-run", "capacity-qualified")?;
        }
        let qualified_run = if has_ineligible {
            "nir1-capacity-qualified-run"
        } else {
            NIR1_CAPACITY_RUN_ID
        };
        for plan in qualified_plans {
            let created =
                create_planned_revision(&db, plan, qualified_run, revision_ordinal, true)?;
            revision_ordinal = revision_ordinal.saturating_add(1);
            ensure!(
                !created.revision_id.is_empty(),
                "typed fixture revision id is empty"
            );
        }

        // Close the owning connection's write transaction state before the
        // process leaves this scope.  A non-empty sidecar would make a plain
        // file copy lose rows, so checkpointing is part of fixture validity.
        db.with_conn(|conn| {
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            Ok::<(), anyhow::Error>(())
        })?;
    }

    let checkpoint = verify_checkpointed_copy(&output_path)?;
    // The generated file is the immutable preseed source.  Keep all shape
    // inspection on a disposable copy: the production measurement owner may
    // later perform a writeful publish/verify sequence, which must never make
    // the source fixture dirty or invalidate its checkpoint receipt.
    let source_snapshot = snapshot_fixture_files(&output_path)?;
    let observed =
        measure_on_disposable_copy(&output_path, case_id, NIR1_CAPACITY_FIXTURE_PROJECT_ID)?;
    ensure!(
        snapshot_fixture_files(&output_path)? == source_snapshot,
        "capacity measurement changed the immutable fixture source"
    );
    let seeded_live_source_bytes = read_live_source_bytes(&output_path)?;
    let persisted_verify_report_records = read_persisted_verify_report_records_from_file(
        &output_path,
        NIR1_CAPACITY_FIXTURE_PROJECT_ID,
    )?;
    if case_id == "D2064/report-heavy" {
        let report_records = persisted_verify_report_records.ok_or_else(|| {
            anyhow::anyhow!(
                "{case_id}: completed dependency Verify outcome has no persisted report"
            )
        })?;
        ensure!(
            report_records > 0,
            "{case_id}: completed dependency Verify outcome has an empty missing-Source report"
        );
        ensure!(
            observed.counts.report_records == Some(report_records),
            "{case_id}: normal capacity probe report count differs from persisted Verify report"
        );
    }
    // The read-only metadata readers above may create SQLite's shared-memory
    // sidecar even after the initial checkpoint. Close them before the final
    // checkpoint receipt so the returned source has no dirty sidecars.
    verify_checkpointed_copy(&output_path)?;
    validate_observed_shape(&expected, &observed, case_id)?;
    validate_candidate_shape(&expected, &observed, case_id)?;
    Ok(CapacityFixtureBuildResult {
        schema_version: NIR1_CAPACITY_FIXTURE_SCHEMA_VERSION,
        diagnostic_only: true,
        case_id: case_id.to_owned(),
        database_path: output_path.display().to_string(),
        expected,
        observed,
        seeded_live_source_bytes,
        persisted_verify_report_records,
        category_counts,
        checkpoint,
    })
}

#[derive(Debug)]
struct Catalog {
    entries: Vec<CatalogEntry>,
    relations: Vec<CatalogRelation>,
}

fn catalog_for_plans(plans: &[RevisionPlan]) -> Catalog {
    let mut entry_ids = BTreeSet::new();
    let mut entries = Vec::new();
    let mut relation_ids = BTreeSet::new();
    let mut relations = Vec::new();
    for plan in plans {
        for (index, id) in plan.entity_ids.iter().enumerate() {
            if entry_ids.insert(id.clone()) {
                let summary = if plan.byte_heavy {
                    format!("{}:{} 日本語", id, "x".repeat(3_900))
                } else {
                    format!("fixture source {id} 日本語")
                };
                // Reused Evidence cases intentionally reuse the same source
                // row across revisions; the material remains revision-bound.
                let _ = index;
                entries.push(CatalogEntry {
                    id: id.clone(),
                    summary,
                });
            }
        }
        for relation_id in &plan.relation_ids {
            if relation_ids.insert(relation_id.clone()) {
                let from_id = plan.entity_ids.first().cloned().unwrap_or_default();
                let to_id = plan
                    .entity_ids
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| from_id.clone());
                relations.push(CatalogRelation {
                    id: relation_id.clone(),
                    from_id,
                    to_id,
                });
            }
        }
    }
    Catalog { entries, relations }
}

fn seed_catalog_and_authorities(
    db: &Database,
    entries: &[CatalogEntry],
    relations: &[CatalogRelation],
) -> Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title, language) VALUES (?1, ?2, 'en')",
            params![NIR1_CAPACITY_FIXTURE_PROJECT_ID, "NIR-1 capacity fixture"],
        )?;
        create_epoch_in_tx(conn, NIR1_CAPACITY_FIXTURE_PROJECT_ID, "initial", None)?;
        Database::record_c2zc_cutover_marker(conn, "2026-09-17T00:00:00.000Z")?;
        conn.execute(
            "INSERT INTO narrative_change_cursors
                (project_id, consumer_id, acknowledged_through_sequence,
                 last_error, updated_at)
             VALUES (?1, ?2, 0, NULL, ?3)",
            params![
                NIR1_CAPACITY_FIXTURE_PROJECT_ID,
                super::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID,
                NIR1_CAPACITY_UPDATED_AT,
            ],
        )?;
        for (scene_id, title, sort_order) in [
            (
                NIR1_CAPACITY_FIXTURE_SCENE_ID,
                "NIR-1 capacity fixture",
                "a0",
            ),
            (
                NIR1_CAPACITY_SCOPE_DRIFT_SCENE_ID,
                "NIR-1 capacity scope drift",
                "a1",
            ),
        ] {
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, content, sort_order)
                 VALUES (?1, ?2, 'scene', ?3, '{}', ?4)",
                params![
                    scene_id,
                    NIR1_CAPACITY_FIXTURE_PROJECT_ID,
                    title,
                    sort_order
                ],
            )?;
            ensure_scene_scope_binding_in_tx(
                conn,
                NIR1_CAPACITY_FIXTURE_PROJECT_ID,
                scene_id,
                NIR1_CAPACITY_UPDATED_AT,
            )?;
        }
        for entry in entries {
            conn.execute(
                "INSERT INTO codex_entries
                    (id, project_id, type, name, aliases, summary, content, notes,
                     context_mode, created_at, updated_at)
                 VALUES (?1, ?2, 'character', ?3, NULL, ?4, '{}', NULL,
                         'mentioned', ?5, ?5)",
                params![
                    entry.id,
                    NIR1_CAPACITY_FIXTURE_PROJECT_ID,
                    entry.id,
                    entry.summary,
                    NIR1_CAPACITY_UPDATED_AT,
                ],
            )?;
        }
        for relation in relations {
            conn.execute(
                "INSERT INTO codex_relations
                    (id, project_id, from_codex_id, to_codex_id, relation_type,
                     directionality, version, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'related', 'directed', 1, ?5)",
                params![
                    relation.id,
                    NIR1_CAPACITY_FIXTURE_PROJECT_ID,
                    relation.from_id,
                    relation.to_id,
                    NIR1_CAPACITY_UPDATED_AT,
                ],
            )?;
        }
        Ok(())
    })
}

fn create_typed_run(db: &Database, run_id: &str, label: &str) -> Result<()> {
    narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_owned()),
            project_id: NIR1_CAPACITY_FIXTURE_PROJECT_ID.to_owned(),
            surface_path_id: NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH.to_owned(),
            scope_json: json!({"fixture": label}),
            spec_json: json!({"kind": "nir1.capacity.fixture", "version": 1}),
            spec_digest: format!("nir1-capacity-fixture:{label}"),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: Vec::new(),
        },
    )?;
    Ok(())
}

struct CreatedRevision {
    revision_id: String,
}

fn create_planned_revision(
    db: &Database,
    plan: &RevisionPlan,
    run_id: &str,
    ordinal: usize,
    approve: bool,
) -> Result<CreatedRevision> {
    let bundle = bundle_for_plan(db, plan)?;
    let created = create_nir1_entity_relation_revision(
        db,
        Nir1EntityRelationRevisionRequest {
            run_id: run_id.to_owned(),
            project_id: NIR1_CAPACITY_FIXTURE_PROJECT_ID.to_owned(),
            proposal_key: format!("nir1:capacity:{}:{ordinal}", plan.index),
            bundle,
        },
    )?;
    let proposal_id = created
        .get("proposalId")
        .and_then(serde_json::Value::as_str)
        .context("typed fixture writer omitted proposalId")?;
    let revision_id = created
        .get("revisionId")
        .and_then(serde_json::Value::as_str)
        .context("typed fixture writer omitted revisionId")?
        .to_owned();
    if approve {
        let decision = if plan.category == Some("rejected") {
            "rejected"
        } else {
            "approved"
        };
        narrative_extraction_append_human_decision(
            db,
            AppendDecisionPayload {
                run_id: run_id.to_owned(),
                project_id: NIR1_CAPACITY_FIXTURE_PROJECT_ID.to_owned(),
                proposal_id: proposal_id.to_owned(),
                revision_id: revision_id.clone(),
                decision: decision.to_owned(),
                decision_json: None,
                created_by: Some("capacity-fixture-builder".to_owned()),
            },
        )?;
    }
    Ok(CreatedRevision { revision_id })
}

fn create_and_record_invalid_plan(
    db: &Database,
    plan: &RevisionPlan,
    run_id: &str,
    revision_ordinal: &mut usize,
    category_counts: &mut BTreeMap<String, usize>,
    source_drift_ids: &mut Vec<String>,
    stale_revision_ids: &mut Vec<String>,
) -> Result<()> {
    let created = create_planned_revision(
        db,
        plan,
        run_id,
        *revision_ordinal,
        plan.category != Some("decisionless"),
    )?;
    *revision_ordinal = revision_ordinal.saturating_add(1);
    if let Some(category) = plan.category {
        *category_counts.entry(category.to_owned()).or_default() += 1;
        match category {
            "source-drift" => source_drift_ids.extend(plan.entity_ids.iter().cloned()),
            "stale-freshness" => stale_revision_ids.push(created.revision_id.clone()),
            "scope-drift" | "report-missing-source" | "decisionless" | "rejected" => {}
            other => anyhow::bail!("unknown capacity fixture category {other}"),
        }
    }
    // The returned identity is deliberately observed, even though the
    // fixture metadata is measured from the reopened DB below.
    ensure!(
        !created.revision_id.is_empty(),
        "typed fixture revision id is empty"
    );
    Ok(())
}

fn bundle_for_plan(db: &Database, plan: &RevisionPlan) -> Result<EntityRelationBundle> {
    let authority = db.with_read_transaction(|conn| {
        load_live_project_scope_authority(
            conn,
            NIR1_CAPACITY_FIXTURE_PROJECT_ID,
            &format!("project:scope-authority:{NIR1_CAPACITY_FIXTURE_PROJECT_ID}"),
        )
    })?;
    let reveal = authority
        .scope_registry
        .reserved_audience_refs
        .first()
        .cloned()
        .context("capacity fixture scope authority has no reserved audience")?;
    let scope = ScopeBinding {
        reading: ScopeValue::Exact {
            value: format!("scene:{}", plan.scene_id),
        },
        story: ScopeValue::Any {
            purpose: Some("nir1-capacity-fixture".to_owned()),
        },
        auto: ScopeValue::NotApplicable {
            reason: "capacity-fixture".to_owned(),
        },
        phase: "draft".to_owned(),
        reveal,
        pov: None,
        authority_revision: authority.source.revision_token,
    };
    let mut entities = Vec::with_capacity(plan.entity_ids.len());
    for entity_id in &plan.entity_ids {
        let summary = db.with_read_transaction(|conn| {
            Ok(conn.query_row(
                "SELECT summary, name, updated_at FROM codex_entries
                  WHERE id=?1 AND project_id=?2",
                params![entity_id, NIR1_CAPACITY_FIXTURE_PROJECT_ID],
                |row| {
                    let summary: Option<String> = row.get(0)?;
                    let name: String = row.get(1)?;
                    let updated_at: String = row.get(2)?;
                    Ok((summary, name, updated_at))
                },
            )?)
        })?;
        let quote = summary
            .0
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(summary.1);
        let evidence_id = if plan.shared_materials {
            format!("nir1:capacity:evidence:shared:{}", entity_id)
        } else {
            format!("nir1:capacity:evidence:{}:{}", plan.index, entity_id)
        };
        entities.push(EntityInput {
            entity_id: entity_id.clone(),
            entity_type: "character".to_owned(),
            label: entity_id.clone(),
            source_token: format!("codex:{entity_id}@{}", summary.2),
            scope: scope.clone(),
            evidence: vec![EvidenceInput {
                evidence_id,
                source_ref: format!("codex:{entity_id}"),
                start_utf16: 0,
                end_utf16: quote.encode_utf16().count(),
                quote,
            }],
        });
    }
    let evidence_ids = entities
        .iter()
        .take(2)
        .filter_map(|entity| {
            entity
                .evidence
                .first()
                .map(|evidence| evidence.evidence_id.clone())
        })
        .collect::<Vec<_>>();
    let relations = plan
        .relation_ids
        .iter()
        .map(|relation_id| GraphEdgeInput {
            edge_id: relation_id.clone(),
            from_entity_id: entities
                .first()
                .map(|entity| entity.entity_id.clone())
                .unwrap_or_default(),
            to_entity_id: entities
                .get(1)
                .map(|entity| entity.entity_id.clone())
                .unwrap_or_default(),
            relation_type: "related".to_owned(),
            directionality: "directed".to_owned(),
            source_token: format!("v1@{}:relation:{relation_id}", NIR1_CAPACITY_UPDATED_AT),
            evidence_ids: evidence_ids.clone(),
        })
        .collect();
    Ok(EntityRelationBundle {
        project_id: NIR1_CAPACITY_FIXTURE_PROJECT_ID.to_owned(),
        revision_id: "capacity-fixture-native-placeholder".to_owned(),
        producer: ENTITY_RELATION_PRODUCER.to_owned(),
        entities,
        relations,
    })
}

fn mutate_source_drift_candidates(db: &Database, source_drift_ids: &[String]) -> Result<()> {
    db.with_conn(|conn| {
        for entity_id in source_drift_ids {
            conn.execute(
                "UPDATE codex_entries SET summary=?1, updated_at=?2
                  WHERE id=?3 AND project_id=?4",
                params![
                    format!("source drift for {entity_id}"),
                    NIR1_CAPACITY_SOURCE_DRIFTED_AT,
                    entity_id,
                    NIR1_CAPACITY_FIXTURE_PROJECT_ID,
                ],
            )?;
        }
        Ok(())
    })
}

/// Seed a canonical stale Freshness result without changing any live Source.
///
/// The stale candidates are deliberately published through the existing
/// runless Freshness owner. This keeps the Edge State and Consumer Freshness
/// rows coherent while leaving the Source revision token recorded in each
/// Revision unchanged. The typed reader therefore reaches its canonical
/// Freshness gate and reports `canonical-freshness-unavailable`, rather than
/// stopping at the earlier live-Source validation gate.
fn seed_stale_freshness_candidates(db: &Database, revision_ids: &[String]) -> Result<()> {
    db.with_conn(|conn| {
        super::with_immediate_transaction(conn, |conn| {
            let epoch = super::get_current_epoch(conn, NIR1_CAPACITY_FIXTURE_PROJECT_ID)?
                .context("capacity fixture has no current Semantic Epoch")?;
            let stale = EdgeObservation {
                freshness: EvidenceFreshness::Stale,
                reason_code: Some(FindingReasonCode::ReadSetDrift),
                build_action: BuildAction::RevalidateExact,
            };
            for revision_id in revision_ids {
                let edges = super::find_edges_by_consumer(
                    conn,
                    NIR1_CAPACITY_FIXTURE_PROJECT_ID,
                    "proposal-revision",
                    revision_id,
                )?;
                ensure!(
                    !edges.is_empty(),
                    "stale-freshness fixture revision has no dependency edges: {revision_id}"
                );
                let observations = edges
                    .into_iter()
                    .map(|edge| (edge.id, stale))
                    .collect::<Vec<_>>();
                publish_complete_runless_freshness_in_tx(
                    conn,
                    NIR1_CAPACITY_FIXTURE_PROJECT_ID,
                    "proposal-revision",
                    revision_id,
                    &observations,
                    &epoch.id,
                    NIR1_CAPACITY_FRESHNESS_STALE_AT,
                )?;
            }
            Ok::<(), anyhow::Error>(())
        })
    })
}

fn mutate_scope_registry(db: &Database) -> Result<()> {
    let current = db.with_read_transaction(|conn| {
        read_narrative_scene_scope(
            conn,
            NIR1_CAPACITY_FIXTURE_PROJECT_ID,
            NIR1_CAPACITY_SCOPE_DRIFT_SCENE_ID,
        )
    })?;
    update_narrative_scene_scope_registry(
        db,
        NarrativeSceneScopeRegistryUpdatePayload {
            project_id: NIR1_CAPACITY_FIXTURE_PROJECT_ID.to_owned(),
            request_id: "nir1-capacity-scope-drift-request".to_owned(),
            session_id: "nir1-capacity-fixture-session".to_owned(),
            event_uid: "nir1-capacity-scope-drift-event".to_owned(),
            base_version: current.registry_revision,
            updated_at: NIR1_CAPACITY_DRIFTED_AT.to_owned(),
            registry: NarrativeSceneScopeRegistryV1 {
                registry_version: current.registry.registry_version,
                timeline_refs: vec!["timeline:capacity-drift".to_owned()],
                worldline_refs: vec!["worldline:capacity-drift".to_owned()],
                narrative_layer_refs: vec!["layer:capacity-drift".to_owned()],
            },
        },
    )?;
    Ok(())
}

fn hide_report_heavy_sources(db: &Database) -> Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE codex_entries SET context_mode='hidden', updated_at=?1
              WHERE project_id=?2 AND id LIKE 'nir1-capacity-d-report-missing-source-%'",
            params![NIR1_CAPACITY_DRIFTED_AT, NIR1_CAPACITY_FIXTURE_PROJECT_ID],
        )?;
        Ok(())
    })
}

fn verify_checkpointed_copy(path: &Path) -> Result<FixtureCheckpoint> {
    let wal_path = PathBuf::from(format!("{}-wal", path.display()));
    let shm_path = PathBuf::from(format!("{}-shm", path.display()));
    let wal_bytes = fs::metadata(&wal_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    ensure!(
        wal_bytes == 0,
        "fixture WAL is not checkpointed: {wal_bytes} bytes"
    );
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let _: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row.get(0))?;
    drop(conn);
    // A clean WAL checkpoint can still leave SQLite's shared-memory index
    // allocated (commonly 32 KiB). Once every connection is closed and WAL
    // is empty, remove both sidecars so a plain file copy is self-contained.
    remove_sidecar(&wal_path)?;
    remove_sidecar(&shm_path)?;
    ensure!(
        !wal_path.exists(),
        "fixture WAL sidecar remains after close"
    );
    ensure!(
        !shm_path.exists(),
        "fixture SHM sidecar remains after close"
    );
    Ok(FixtureCheckpoint {
        database_path: path.display().to_string(),
        wal_bytes,
        shm_bytes: 0,
        reopened_read_only: true,
    })
}

fn remove_sidecar(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FixtureFilesSnapshot {
    main: Vec<u8>,
    wal: Option<Vec<u8>>,
    shm: Option<Vec<u8>>,
}

fn snapshot_fixture_files(path: &Path) -> Result<FixtureFilesSnapshot> {
    let read_optional = |sidecar: PathBuf| -> Result<Option<Vec<u8>>> {
        match fs::read(&sidecar) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    };
    Ok(FixtureFilesSnapshot {
        main: fs::read(path).with_context(|| format!("read fixture source {}", path.display()))?,
        wal: read_optional(PathBuf::from(format!("{}-wal", path.display())))?,
        shm: read_optional(PathBuf::from(format!("{}-shm", path.display())))?,
    })
}

fn measure_on_disposable_copy(
    source_path: &Path,
    case_id: &str,
    project_id: &str,
) -> Result<CapacityObservation> {
    let copy_path = source_path.with_file_name(format!(
        "{}.capacity-observe-{}.db",
        source_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("fixture"),
        std::process::id()
    ));
    ensure!(
        !copy_path.exists(),
        "capacity observation copy already exists: {}",
        copy_path.display()
    );
    fs::copy(source_path, &copy_path).with_context(|| {
        format!(
            "copy immutable fixture for capacity observation {} -> {}",
            source_path.display(),
            copy_path.display()
        )
    })?;
    let result = measure_capacity(&copy_path, case_id, Some(project_id));
    let cleanup_result = remove_fixture_copy(&copy_path);
    match (result, cleanup_result) {
        (Ok(observation), Ok(())) => Ok(observation),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error.context("remove disposable capacity observation copy")),
        (Err(error), Err(cleanup_error)) => Err(error.context(format!(
            "remove disposable capacity observation copy: {cleanup_error}"
        ))),
    }
}

fn remove_fixture_copy(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", path.display(), suffix));
        match fs::remove_file(sidecar) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn read_live_source_bytes(path: &Path) -> Result<u64> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("open fixture for live Source byte count {}", path.display()))?;
    let bytes: i64 = conn.query_row(
        "SELECT COALESCE(SUM(
                    length(CAST(COALESCE(name, '') AS BLOB))
                  + length(CAST(COALESCE(summary, '') AS BLOB))
                ), 0)
           FROM codex_entries
          WHERE project_id=?1",
        params![NIR1_CAPACITY_FIXTURE_PROJECT_ID],
        |row| row.get(0),
    )?;
    Ok(u64::try_from(bytes)?)
}

fn read_persisted_verify_report_records_from_file(
    path: &Path,
    project_id: &str,
) -> Result<Option<u64>> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("open fixture for Verify report count {}", path.display()))?;
    read_persisted_verify_report_records(&conn, project_id)
}

fn validate_observed_shape(
    expected: &FixtureExpectedShape,
    observed: &CapacityObservation,
    case_id: &str,
) -> Result<()> {
    if let Some(expected) = expected.qualified_materials {
        ensure!(
            observed.counts.qualified_material_records == expected,
            "{case_id}: expected {expected} qualified material records, observed {}",
            observed.counts.qualified_material_records
        );
    }
    if let Some(expected) = expected.qualified_revisions {
        ensure!(
            observed.counts.qualified_revisions == expected,
            "{case_id}: expected {expected} qualified revisions, observed {}",
            observed.counts.qualified_revisions
        );
    }
    if let Some(expected) = expected.ineligible_candidates {
        ensure!(
            observed.counts.rejected_revisions == expected,
            "{case_id}: expected {expected} rejected candidates, observed {}",
            observed.counts.rejected_revisions
        );
    }
    Ok(())
}

fn validate_candidate_shape(
    expected: &FixtureExpectedShape,
    observed: &CapacityObservation,
    case_id: &str,
) -> Result<()> {
    let expected_candidates = expected
        .qualified_revisions
        .unwrap_or(0)
        .saturating_add(expected.ineligible_candidates.unwrap_or(0));
    if expected_candidates > 0 {
        ensure!(
            observed.counts.candidate_revisions == expected_candidates,
            "{case_id}: expected {expected_candidates} candidate revisions, observed {}",
            observed.counts.candidate_revisions
        );
    }
    Ok(())
}

fn plan_case(case_id: &str, expected: &FixtureExpectedShape) -> Result<Vec<RevisionPlan>> {
    let qualified = expected.qualified_materials.unwrap_or(0);
    let revisions = expected
        .qualified_revisions
        .unwrap_or_else(|| match case_id {
            "Q2044/byte-heavy" | "Q2044/evidence-shared" | "Q2044/evidence-unique" => 4,
            _ => 0,
        });
    let mut plans = Vec::new();
    let mut index = 0usize;
    if let Some(ineligible) = expected.ineligible_candidates {
        let categories = [
            ("decisionless", ineligible / 5),
            ("rejected", ineligible / 5),
            ("source-drift", ineligible / 5),
            ("stale-freshness", ineligible / 5),
            (
                if case_id == "D2064/report-heavy" {
                    "report-missing-source"
                } else {
                    "scope-drift"
                },
                ineligible / 5 + ineligible % 5,
            ),
        ];
        for (category, count) in categories {
            for ordinal in 0..count {
                let entity_id = format!("nir1-capacity-d-{category}-{ordinal}");
                plans.push(RevisionPlan {
                    index,
                    entity_ids: vec![entity_id],
                    relation_ids: Vec::new(),
                    scene_id: if category == "scope-drift" {
                        NIR1_CAPACITY_SCOPE_DRIFT_SCENE_ID.to_owned()
                    } else {
                        NIR1_CAPACITY_FIXTURE_SCENE_ID.to_owned()
                    },
                    category: Some(category),
                    byte_heavy: false,
                    shared_materials: false,
                });
                index = index.saturating_add(1);
            }
        }
    }
    if qualified == 0 {
        return Ok(plans);
    }
    ensure!(
        revisions > 0,
        "{case_id}: qualified revisions are required for qualified materials"
    );
    let partition = partition_materials(qualified, revisions)?;
    let shared = case_id == "Q2044/evidence-shared";
    let byte_heavy = case_id == "Q2044/byte-heavy";
    for (revision_index, material_count) in partition.into_iter().enumerate() {
        let relation_count = usize::from(material_count >= 3 && material_count % 2 == 1);
        let entity_count = (material_count.saturating_sub(relation_count)) / 2;
        let entity_ids = (0..entity_count)
            .map(|entity_index| {
                if shared {
                    format!("nir1-capacity-shared-entity-{entity_index}")
                } else {
                    format!("nir1-capacity-q-r{revision_index}-e{entity_index}")
                }
            })
            .collect::<Vec<_>>();
        let relation_ids = (0..relation_count)
            .map(|relation_index| {
                if shared {
                    format!("nir1-capacity-shared-relation-{relation_index}")
                } else {
                    format!("nir1-capacity-q-r{revision_index}-rel{relation_index}")
                }
            })
            .collect::<Vec<_>>();
        plans.push(RevisionPlan {
            index,
            entity_ids,
            relation_ids,
            scene_id: NIR1_CAPACITY_FIXTURE_SCENE_ID.to_owned(),
            category: None,
            byte_heavy,
            shared_materials: shared,
        });
        index = index.saturating_add(1);
    }
    Ok(plans)
}

fn partition_materials(total: usize, revisions: usize) -> Result<Vec<usize>> {
    ensure!(
        revisions > 0,
        "capacity fixture revision count must be positive"
    );
    let base = total / revisions;
    let remainder = total % revisions;
    ensure!(
        base.saturating_add(usize::from(remainder > 0)) <= MAX_REVISION_MATERIAL_RECORDS,
        "capacity fixture would exceed the per-Revision request envelope"
    );
    Ok((0..revisions)
        .map(|index| base + usize::from(index < remainder))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::nir1_capacity_diagnostics::{
        measure_capacity_mode, CapacityDiagnosticMode,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(suffix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("nir1-capacity-fixture-{suffix}-{nonce}.db"))
    }

    #[test]
    fn partition_respects_each_revision_envelope() -> Result<()> {
        let partitions = partition_materials(8_176, 16)?;
        assert_eq!(partitions.len(), 16);
        assert_eq!(partitions.iter().sum::<usize>(), 8_176);
        assert!(partitions.iter().all(|count| *count <= 511));
        Ok(())
    }

    #[test]
    fn manifest_matrix_partitions_to_declared_shapes() -> Result<()> {
        let manifest_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../evals/nir1-capacity/manifest.v1.json");
        let manifest: CapacityManifest = serde_json::from_str(&fs::read_to_string(manifest_path)?)?;
        let mut seen = BTreeSet::new();
        for spec in manifest.fixtures {
            let expected = FixtureExpectedShape {
                qualified_materials: spec.qualified_materials,
                qualified_revisions: spec.qualified_revisions,
                ineligible_candidates: spec.ineligible_candidates,
            };
            let plans = plan_case(&spec.id, &expected)?;
            seen.insert(spec.id.clone());
            let qualified = plans
                .iter()
                .filter(|plan| plan.category.is_none())
                .collect::<Vec<_>>();
            if let Some(materials) = expected.qualified_materials {
                let observed = qualified
                    .iter()
                    .map(|plan| {
                        plan.entity_ids
                            .len()
                            .saturating_mul(2)
                            .saturating_add(plan.relation_ids.len())
                    })
                    .sum::<usize>();
                assert_eq!(observed, materials, "{} qualified material plan", spec.id);
            }
            if let Some(revisions) = expected.qualified_revisions {
                assert_eq!(qualified.len(), revisions, "{} revision plan", spec.id);
            } else if expected.qualified_materials.is_some() {
                assert_eq!(qualified.len(), 4, "{} default revision plan", spec.id);
            }
            if let Some(candidates) = expected.ineligible_candidates {
                assert_eq!(
                    plans.iter().filter(|plan| plan.category.is_some()).count(),
                    candidates,
                    "{} ineligible candidate plan",
                    spec.id
                );
            }
            assert!(plans
                .iter()
                .filter(|plan| plan.category.is_none())
                .all(|plan| {
                    plan.entity_ids
                        .len()
                        .saturating_mul(2)
                        .saturating_add(plan.relation_ids.len())
                        <= MAX_REVISION_MATERIAL_RECORDS
                }));
        }
        assert_eq!(seen.len(), 9);
        Ok(())
    }

    #[test]
    fn q513_fixture_reopens_and_preserves_qualified_shape() -> Result<()> {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../evals/nir1-capacity/manifest.v1.json");
        let output = temp_path("q513");
        let result = build_fixture_from_manifest(&manifest, "Q513/R3/D0", &output)?;
        assert_eq!(result.observed.counts.qualified_material_records, 513);
        assert_eq!(result.observed.counts.qualified_revisions, 3);
        assert_eq!(result.observed.counts.candidate_revisions, 3);
        assert!(result.seeded_live_source_bytes > 0);
        assert!(result.checkpoint.reopened_read_only);
        let original = fs::read(&output)?;
        let copy = temp_path("q513-copy");
        fs::copy(&output, &copy)?;
        let copied = measure_capacity(&copy, "Q513/R3/D0", Some(NIR1_CAPACITY_FIXTURE_PROJECT_ID))?;
        assert_eq!(copied.counts.qualified_material_records, 513);
        assert_eq!(copied.counts.qualified_revisions, 3);
        assert_eq!(fs::read(&output)?, original);
        remove_fixture_copy(&output)?;
        remove_fixture_copy(&copy)?;
        Ok(())
    }

    #[test]
    fn q513_with_ineligible_candidates_keeps_qualified_rows() -> Result<()> {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../evals/nir1-capacity/manifest.v1.json");
        let output = temp_path("q513-d516");
        let result = build_fixture_from_manifest(&manifest, "Q513/R3/D516", &output)?;
        assert_eq!(result.observed.counts.qualified_material_records, 513);
        assert_eq!(result.observed.counts.qualified_revisions, 3);
        assert_eq!(result.observed.counts.rejected_revisions, 516);
        assert_eq!(result.observed.counts.candidate_revisions, 519);
        let stale_count = *result
            .category_counts
            .get("stale-freshness")
            .expect("stale-freshness category");
        let source_drift_count = *result
            .category_counts
            .get("source-drift")
            .expect("source-drift category");
        let scope_drift_count = *result
            .category_counts
            .get("scope-drift")
            .expect("scope-drift category");
        assert_eq!(
            result
                .observed
                .rejection_reasons
                .get("canonical-freshness-unavailable"),
            Some(&stale_count),
            "stale-freshness candidates must reach the canonical Freshness gate: {:?}",
            result.observed.rejection_reasons
        );
        assert_eq!(
            result
                .observed
                .rejection_reasons
                .get("source-revision-changed"),
            Some(&(source_drift_count + scope_drift_count)),
            "source-drift and scope-drift candidates must remain source-revision failures"
        );
        let conn =
            Connection::open_with_flags(&output, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let stale_source_token: String = conn.query_row(
            "SELECT updated_at FROM codex_entries
              WHERE id='nir1-capacity-d-stale-freshness-0'
                AND project_id=?1",
            [NIR1_CAPACITY_FIXTURE_PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_eq!(
            stale_source_token, NIR1_CAPACITY_UPDATED_AT,
            "stale-freshness must preserve the live Source revision token"
        );
        remove_fixture_copy(&output)?;
        Ok(())
    }

    #[test]
    fn report_heavy_separates_fixture_and_operation_verify_report_counts() -> Result<()> {
        let manifest = temp_path("report-heavy-manifest");
        fs::write(
            &manifest,
            r#"{
                "schemaVersion": "nir1-capacity/1",
                "diagnosticOnly": true,
                "fixtures": [
                    {"id": "D2064/report-heavy", "ineligibleCandidates": 5}
                ]
            }"#,
        )?;
        let output = temp_path("report-heavy");
        let result = build_fixture_from_manifest(&manifest, "D2064/report-heavy", &output)?;
        assert_eq!(result.persisted_verify_report_records, Some(1));
        assert_eq!(result.observed.counts.report_records, Some(1));

        let copy = temp_path("report-heavy-copy");
        fs::copy(&output, &copy)?;
        let measured = measure_capacity(
            &copy,
            "D2064/report-heavy",
            Some(NIR1_CAPACITY_FIXTURE_PROJECT_ID),
        )?;
        assert_eq!(measured.counts.report_records, Some(1));
        assert_eq!(measured.fixture_shape.report_records, Some(1));
        assert!(measured.mode_outcome.success);
        assert_eq!(measured.mode_outcome.operation_report_records, Some(1));
        remove_fixture_copy(&copy)?;

        let coverage_copy = temp_path("report-heavy-coverage-copy");
        fs::copy(&output, &coverage_copy)?;
        let coverage = measure_capacity_mode(
            &coverage_copy,
            "D2064/report-heavy",
            Some(NIR1_CAPACITY_FIXTURE_PROJECT_ID),
            CapacityDiagnosticMode::Coverage,
        )?;
        assert!(coverage.mode_outcome.success);
        assert!(coverage.graph_lifecycle.coverage_ms.is_some());
        assert_eq!(coverage.fixture_shape.report_records, Some(1));
        assert_eq!(coverage.mode_outcome.operation_report_records, Some(1));
        remove_fixture_copy(&coverage_copy)?;

        let restore_copy = temp_path("report-heavy-restore-copy");
        fs::copy(&output, &restore_copy)?;
        let restored = measure_capacity_mode(
            &restore_copy,
            "D2064/report-heavy",
            Some(NIR1_CAPACITY_FIXTURE_PROJECT_ID),
            CapacityDiagnosticMode::Restore,
        )?;
        assert!(restored.mode_outcome.success);
        assert!(restored.graph_lifecycle.restore_install_ms.is_some());
        assert!(restored.graph_lifecycle.restore_maintenance_validated);
        assert!(restored.graph_lifecycle.restore_image_identity.is_some());
        assert!(restored
            .graph_lifecycle
            .restore_workspace_identity
            .is_some());
        assert!(restored.graph_lifecycle.restore_epoch.is_some());
        assert_eq!(restored.fixture_shape.report_records, Some(1));
        assert!(
            restored
                .mode_outcome
                .operation_report_records
                .is_some_and(|records| records >= 1),
            "Restore must expose the real post-rebuild Verify report count"
        );
        remove_fixture_copy(&restore_copy)?;

        let conn =
            Connection::open_with_flags(&output, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let finding_observations: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_finding_observations
              WHERE project_id=?1",
            [NIR1_CAPACITY_FIXTURE_PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_eq!(
            finding_observations, 0,
            "report_records must not alias the finding-observation table"
        );
        remove_fixture_copy(&output)?;
        remove_fixture_copy(&copy)?;
        let _ = fs::remove_file(&manifest);
        Ok(())
    }
}
