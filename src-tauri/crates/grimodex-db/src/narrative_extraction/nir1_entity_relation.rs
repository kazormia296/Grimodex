//! Native-owned persistence boundary for reviewed NIR-1 Entity/Relation input.
//!
//! This lane deliberately reuses the existing ProposalSet/Proposal/Revision/
//! Decision ledger.  The bundle is stored as a typed payload with a Native
//! generated revision identity; it is not a promotion of the mutable Codex
//! catalog and it does not create a Graph index or a product-facing reader.

use chrono::Utc;
use grimodex_core::{canonical_json_digest, narrative_nir1};
use grimodex_core::narrative_scope_authority_basis::NarrativeScopeAuthorityStoryTimeOrderV2;
use narrative_nir1::{
    validate_entity_relation_bundle, EntityRelationBundle, ScopeBinding, ScopeValue,
    ENTITY_RELATION_INDEX_KEY, ENTITY_RELATION_PRODUCER, ENTITY_RELATION_SOURCE_KIND,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::repository::{current_chronicle_run_spec_for_run, ensure_run_project};
use super::project_scope_authority::load_live_project_scope_authority;
use super::task_leases::with_immediate_transaction;
use crate::narrative_runtime_policy::require_narrative_extraction_allowed;
use crate::Database;

/// Reserved ProposalSet kind. Generic proposal persistence cannot use this
/// value; the typed adapter below is the only writer for this contract.
pub const NIR1_ENTITY_RELATION_SET_KIND: &str = "nir1.entity-relation.revision@1";
pub const NIR1_ENTITY_RELATION_PROPOSAL_KIND: &str = "nir1.entity-relation@1";
pub const NIR1_ENTITY_RELATION_REVISION_ORIGIN: &str = "nir1-typed";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Nir1EntityRelationRevisionRequest {
    pub run_id: String,
    pub project_id: String,
    pub proposal_key: String,
    /// `revisionId` is replaced by the Native-generated immutable Revision
    /// identity at persistence time. The field remains part of the shared
    /// bundle shape so the same type can be consumed by the graph primitive.
    pub bundle: EntityRelationBundle,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1EntityRelationRevision {
    pub project_id: String,
    pub run_id: String,
    pub proposal_set_id: String,
    pub proposal_id: String,
    pub revision_id: String,
    pub bundle_digest: String,
    pub eligibility_source: &'static str,
    pub index_key: &'static str,
    pub bundle: EntityRelationBundle,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", content = "result", rename_all = "camelCase")]
pub enum Nir1EntityRelationRevisionRead {
    Available(Box<Nir1EntityRelationRevision>),
    Unavailable { reason: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredNir1EntityRelationPayload {
    schema_version: u64,
    kind: String,
    producer: String,
    project_id: String,
    revision_id: String,
    bundle: EntityRelationBundle,
}

pub fn create_nir1_entity_relation_revision(
    db: &Database,
    request: Nir1EntityRelationRevisionRequest,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            create_in_tx(conn, request)
        })
    })
}

fn create_in_tx(
    conn: &Connection,
    request: Nir1EntityRelationRevisionRequest,
) -> anyhow::Result<Value> {
    if request.project_id.trim().is_empty()
        || request.run_id.trim().is_empty()
        || request.proposal_key.trim().is_empty()
        || request.proposal_key.len() > 256
    {
        anyhow::bail!("NIR1_ENTITY_RELATION_INVALID_REQUEST");
    }
    anyhow::ensure!(
        request.bundle.project_id == request.project_id,
        "NIR1_ENTITY_PROJECT_MISMATCH: bundle project differs from trusted project"
    );
    ensure_run_project(conn, &request.run_id, &request.project_id)?;
    anyhow::ensure!(
        !current_chronicle_run_spec_for_run(conn, &request.project_id, &request.run_id)?,
        "NIR1_ENTITY_RELATION_CHRONICLE_FINISH_REQUIRED: current Chronicle Runs must persist typed output through their terminal Task"
    );

    let revision_id = Uuid::new_v4().to_string();
    let mut bundle = request.bundle;
    // The renderer/request supplies material, never the identity of the
    // immutable Revision. This assignment is the actual identity binding.
    bundle.revision_id = revision_id.clone();
    validate_entity_relation_bundle(&bundle)
        .map_err(|error| anyhow::anyhow!("NIR1_ENTITY_RELATION_INPUT_INVALID: {error}"))?;
    validate_live_sources(conn, &request.project_id, &bundle)?;

    let payload = StoredNir1EntityRelationPayload {
        schema_version: 1,
        kind: NIR1_ENTITY_RELATION_PROPOSAL_KIND.into(),
        producer: ENTITY_RELATION_PRODUCER.into(),
        project_id: request.project_id.clone(),
        revision_id: revision_id.clone(),
        bundle: bundle.clone(),
    };
    let payload_value = serde_json::to_value(&payload)?;
    let payload_json = serde_json::to_string(&payload_value)?;
    let payload_digest = canonical_json_digest(&payload_value)?;
    let bundle_digest = canonical_json_digest(&serde_json::to_value(&bundle)?)?;
    let proposal_set_id = Uuid::new_v4().to_string();
    let proposal_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let summary_json = serde_json::to_string(&json!({
        "kind": "nir1.entity-relation.revision-summary@1",
        "producer": ENTITY_RELATION_PRODUCER,
        "bundleDigest": bundle_digest,
        "entityCount": bundle.entities.len(),
        "relationCount": bundle.relations.len(),
    }))?;

    conn.execute(
        "INSERT INTO narrative_proposal_sets
            (id, run_id, project_id, set_kind, status, summary_json,
             created_at, updated_at, version)
         VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?6, ?6, 0)",
        params![
            proposal_set_id,
            request.run_id,
            request.project_id,
            NIR1_ENTITY_RELATION_SET_KIND,
            summary_json,
            created_at,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposals
            (id, proposal_set_id, proposal_key, kind, status, payload_json,
             current_revision_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'unreviewed', ?5, ?6, ?7, ?7)",
        params![
            proposal_id,
            proposal_set_id,
            request.proposal_key,
            NIR1_ENTITY_RELATION_PROPOSAL_KIND,
            payload_json,
            revision_id,
            created_at,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_revisions
            (id, proposal_id, revision_number, payload_json, origin_kind,
             reconciliation_envelope_json, reconciliation_envelope_digest,
             created_at, created_by)
         VALUES (?1, ?2, 1, ?3, ?4, NULL, NULL, ?5, ?6)",
        params![
            revision_id,
            proposal_id,
            serde_json::to_string(&payload_value)?,
            NIR1_ENTITY_RELATION_REVISION_ORIGIN,
            created_at,
            "nir1-native-adapter",
        ],
    )?;

    super::nir1_chronicle_index::invalidate::suspend_project_in_tx(conn, &request.project_id)?;
    Ok(json!({
        "proposalSetId": proposal_set_id,
        "proposalId": proposal_id,
        "revisionId": revision_id,
        "originKind": NIR1_ENTITY_RELATION_REVISION_ORIGIN,
        "producer": ENTITY_RELATION_PRODUCER,
        "indexKey": ENTITY_RELATION_INDEX_KEY,
        "eligibilitySource": ENTITY_RELATION_SOURCE_KIND,
        "payloadDigest": payload_digest,
        "status": "unreviewed",
    }))
}

/// Re-open one typed Revision from a caller-owned read snapshot. Approval is
/// intentionally checked here, not inferred from Proposal status alone: the
/// exact current Decision must be the Native human-review actor.
pub fn read_nir1_entity_relation_revision(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
) -> anyhow::Result<Nir1EntityRelationRevisionRead> {
    if conn.is_autocommit() {
        anyhow::bail!("NIR1_ENTITY_RELATION_REQUIRES_READ_TRANSACTION");
    }
    if project_id.trim().is_empty() || revision_id.trim().is_empty() {
        anyhow::bail!("NIR1_ENTITY_RELATION_INVALID_READ_REQUEST");
    }
    let row: Option<(String, String, String, String, String, String, String)> = conn
        .query_row(
            "SELECT proposal_set.id, proposal_set.run_id, proposal.id,
                    proposal.current_revision_id, proposal.status,
                    revision.origin_kind, revision.payload_json
               FROM narrative_proposal_revisions revision
               JOIN narrative_proposals proposal
                 ON proposal.id = revision.proposal_id
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
              WHERE revision.id = ?1
                AND proposal_set.project_id = ?2
                AND proposal_set.set_kind = ?3",
            params![revision_id, project_id, NIR1_ENTITY_RELATION_SET_KIND],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some((
        proposal_set_id,
        run_id,
        proposal_id,
        current_revision_id,
        status,
        origin,
        payload_json,
    )) = row
    else {
        return Ok(unavailable("revision-not-found"));
    };
    if current_revision_id != revision_id {
        return Ok(unavailable("revision-not-current"));
    }
    if origin != NIR1_ENTITY_RELATION_REVISION_ORIGIN {
        return Ok(unavailable("revision-kind-mismatch"));
    }
    if status != "approved" {
        return Ok(unavailable("revision-not-human-approved"));
    }
    let decision: Option<(String, String, String)> = conn
        .query_row(
            "SELECT decision, actor_kind, actor_id
               FROM narrative_proposal_decisions
              WHERE proposal_id = ?1 AND revision_id = ?2
              ORDER BY created_at DESC, id DESC
              LIMIT 1",
            params![proposal_id, revision_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if decision.as_ref()
        != Some(&(
            "approved".to_owned(),
            "human".to_owned(),
            "electron:human-review".to_owned(),
        ))
    {
        return Ok(unavailable("revision-not-human-approved"));
    }

    let payload: StoredNir1EntityRelationPayload = match serde_json::from_str(&payload_json) {
        Ok(payload) => payload,
        Err(_) => return Ok(unavailable("revision-payload-invalid")),
    };
    if payload.schema_version != 1
        || payload.kind != NIR1_ENTITY_RELATION_PROPOSAL_KIND
        || payload.producer != ENTITY_RELATION_PRODUCER
        || payload.project_id != project_id
        || payload.revision_id != revision_id
        || payload.bundle.project_id != project_id
        || payload.bundle.revision_id != revision_id
    {
        return Ok(unavailable("revision-payload-binding-invalid"));
    }
    if validate_entity_relation_bundle(&payload.bundle).is_err()
        || validate_live_sources(conn, project_id, &payload.bundle).is_err()
    {
        return Ok(unavailable("source-revision-changed"));
    }
    let bundle_digest = canonical_json_digest(&serde_json::to_value(&payload.bundle)?)?;
    Ok(Nir1EntityRelationRevisionRead::Available(
        Box::new(Nir1EntityRelationRevision {
            project_id: project_id.into(),
            run_id,
            proposal_set_id,
            proposal_id,
            revision_id: revision_id.into(),
            bundle_digest,
            eligibility_source: ENTITY_RELATION_SOURCE_KIND,
            index_key: ENTITY_RELATION_INDEX_KEY,
            bundle: payload.bundle,
        }),
    ))
}

fn unavailable(reason: &str) -> Nir1EntityRelationRevisionRead {
    Nir1EntityRelationRevisionRead::Unavailable {
        reason: reason.into(),
    }
}

/// Bind the typed input to the real current Codex/Relation rows. This is a
/// source observation, not a new authority: a later edit makes cold reopen
/// unavailable until a new immutable typed Revision is reviewed.
fn validate_live_sources(
    conn: &Connection,
    project_id: &str,
    bundle: &EntityRelationBundle,
) -> anyhow::Result<()> {
    let authority = load_live_project_scope_authority(
        conn,
        project_id,
        &format!("project:scope-authority:{project_id}"),
    )?;
    for entity in &bundle.entities {
        let current: Option<(String, String, Option<String>, String)> = conn
            .query_row(
                "SELECT type, name, summary, updated_at
                   FROM codex_entries
                  WHERE id = ?1 AND project_id = ?2
                    AND context_mode NOT IN ('hidden', 'suppress')",
                params![entity.entity_id, project_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((entity_type, name, summary, updated_at)) = current else {
            anyhow::bail!(
                "NIR1_ENTITY_SOURCE_MISSING: entity '{}' is not a visible project Codex entry",
                entity.entity_id
            );
        };
        anyhow::ensure!(
            entity.entity_type == entity_type,
            "NIR1_ENTITY_TYPE_STALE: entity '{}' type does not match current Codex entry",
            entity.entity_id
        );
        anyhow::ensure!(
            entity.label == name,
            "NIR1_ENTITY_LABEL_STALE: entity '{}' label does not match current Codex entry",
            entity.entity_id
        );
        let expected = format!("codex:{}@{}", entity.entity_id, updated_at);
        anyhow::ensure!(
            entity.source_token == expected,
            "NIR1_ENTITY_SOURCE_STALE: entity '{}' source token does not match current Codex revision",
            entity.entity_id
        );
        validate_scope_binding(conn, project_id, &entity.scope, &authority)?;
        let canonical_text = summary
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| name.clone());
        for evidence in &entity.evidence {
            anyhow::ensure!(
                evidence.source_ref == format!("codex:{}", entity.entity_id),
                "NIR1_ENTITY_EVIDENCE_SOURCE_MISMATCH: Evidence '{}' is not bound to its Entity",
                evidence.evidence_id
            );
            anyhow::ensure!(
                exact_utf16_quote(
                    &canonical_text,
                    &evidence.quote,
                    evidence.start_utf16,
                    evidence.end_utf16,
                ),
                "NIR1_ENTITY_EVIDENCE_ANCHOR_MISMATCH: Evidence '{}' does not match the current canonical Codex text",
                evidence.evidence_id
            );
        }
    }
    for relation in &bundle.relations {
        let current: Option<(String, String, String, String, i64, String)> = conn
            .query_row(
                "SELECT from_codex_id, to_codex_id, relation_type, directionality,
                        version, updated_at
                   FROM codex_relations
                  WHERE id = ?1 AND project_id = ?2",
                params![relation.edge_id, project_id],
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
            )
            .optional()?;
        let Some((from_id, to_id, relation_type, directionality, version, updated_at)) = current
        else {
            anyhow::bail!(
                "NIR1_RELATION_SOURCE_MISSING: relation '{}' is not a project Relation",
                relation.edge_id
            );
        };
        anyhow::ensure!(
            relation.from_entity_id == from_id
                && relation.to_entity_id == to_id
                && relation.relation_type == relation_type,
            "NIR1_RELATION_ENDPOINT_STALE: relation '{}' no longer matches its endpoints/type",
            relation.edge_id
        );
        anyhow::ensure!(
            relation.directionality == directionality,
            "NIR1_RELATION_SOURCE_STALE: relation '{}' directionality changed",
            relation.edge_id
        );
        let expected = format!("v{}@{}:relation:{}", version, updated_at, relation.edge_id);
        anyhow::ensure!(
            relation.source_token == expected,
            "NIR1_RELATION_SOURCE_STALE: relation '{}' source token does not match current Relation revision",
            relation.edge_id
        );
    }
    Ok(())
}

fn validate_scope_binding(
    conn: &Connection,
    project_id: &str,
    scope: &ScopeBinding,
    authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        authority.project_id == project_id,
        "NIR1_SCOPE_PROJECT_MISMATCH: live Scope authority belongs to another project"
    );
    anyhow::ensure!(
        scope.authority_revision == authority.source.revision_token,
        "NIR1_SCOPE_AUTHORITY_STALE: Scope binding does not match the current project Scope authority revision"
    );

    validate_scope_value(&scope.reading, "reading", authority)?;
    validate_scope_value(&scope.story, "story", authority)?;
    validate_scope_value(&scope.auto, "auto", authority)?;
    anyhow::ensure!(
        authority
            .scope_registry
            .reserved_audience_refs
            .iter()
            .any(|audience| audience == &scope.reveal),
        "NIR1_SCOPE_REVEAL_UNAVAILABLE: reveal audience is not reserved by the current Scope authority"
    );
    if let Some(pov) = scope.pov.as_deref() {
        let visible_pov = conn
            .query_row(
                "SELECT 1
                   FROM codex_entries
                  WHERE id = ?1 AND project_id = ?2
                    AND context_mode NOT IN ('hidden', 'suppress')",
                params![pov, project_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        anyhow::ensure!(
            visible_pov,
            "NIR1_SCOPE_POV_UNAVAILABLE: POV '{}' is not a visible project Codex entry",
            pov
        );
    }
    Ok(())
}

fn validate_scope_value(
    value: &ScopeValue,
    field: &str,
    authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
) -> anyhow::Result<()> {
    let ScopeValue::Exact { value } = value else {
        return Ok(());
    };
    let known = authority.mappings.iter().any(|mapping| {
        if field == "reading" {
            mapping.scene_ref == *value || mapping.reading_order_ref == *value
        } else if field == "story" {
            mapping.story_time_ref == *value
                && matches!(
                    &mapping.story_time_order,
                    NarrativeScopeAuthorityStoryTimeOrderV2::Resolved { .. }
                )
        } else {
            mapping.scene_ref == *value
                || mapping.reading_order_ref == *value
                || (mapping.story_time_ref == *value
                    && matches!(
                        &mapping.story_time_order,
                        NarrativeScopeAuthorityStoryTimeOrderV2::Resolved { .. }
                    ))
        }
    });
    anyhow::ensure!(
        known,
        "NIR1_SCOPE_REFERENCE_UNAVAILABLE: {field} Scope reference '{}' is not resolved by the current project Scope authority",
        value
    );
    Ok(())
}

fn exact_utf16_quote(text: &str, quote: &str, start: usize, end: usize) -> bool {
    if quote.is_empty() || start >= end || end - start != quote.encode_utf16().count() {
        return false;
    }
    let units = text.encode_utf16().collect::<Vec<_>>();
    units
        .get(start..end)
        .is_some_and(|range| String::from_utf16(range).is_ok_and(|value| value == quote))
}

#[cfg(test)]
mod tests {
    use super::{
        create_nir1_entity_relation_revision, read_nir1_entity_relation_revision,
        Nir1EntityRelationRevisionRead, Nir1EntityRelationRevisionRequest,
        NIR1_ENTITY_RELATION_SET_KIND,
    };
    use crate::narrative_extraction::{
        narrative_extraction_append_human_decision, narrative_extraction_append_revision,
        narrative_extraction_save_proposal_set, AppendDecisionPayload, AppendRevisionPayload,
        CreateRunPayload, SaveProposalSetPayload,
    };
    use crate::test_support::fresh_migrated_memory;
    use grimodex_core::narrative_nir1::{
        EntityInput, EntityRelationBundle, EvidenceInput, GraphEdgeInput, ScopeBinding, ScopeValue,
    };
    use serde_json::json;

    fn valid_bundle(project_id: &str, authority_revision: String) -> EntityRelationBundle {
        EntityRelationBundle {
            project_id: project_id.to_owned(),
            revision_id: "renderer-must-not-own-this".into(),
            producer: "nir1-reviewed-entity-relation-v1".into(),
            entities: vec![
                EntityInput {
                    entity_id: "nir1-alice".into(),
                    entity_type: "character".into(),
                    label: "Alice".into(),
                    source_token: "codex:nir1-alice@2026-09-12T00:00:00Z".into(),
                    scope: scope(authority_revision.clone()),
                    evidence: vec![EvidenceInput {
                        evidence_id: "nir1-evidence-alice".into(),
                        source_ref: "codex:nir1-alice".into(),
                        start_utf16: 0,
                        end_utf16: 5,
                        quote: "Alice".into(),
                    }],
                },
                EntityInput {
                    entity_id: "nir1-bob".into(),
                    entity_type: "character".into(),
                    label: "Bob".into(),
                    source_token: "codex:nir1-bob@2026-09-12T00:00:00Z".into(),
                    scope: scope(authority_revision),
                    evidence: vec![EvidenceInput {
                        evidence_id: "nir1-evidence-bob".into(),
                        source_ref: "codex:nir1-bob".into(),
                        start_utf16: 0,
                        end_utf16: 3,
                        quote: "Bob".into(),
                    }],
                },
            ],
            relations: vec![GraphEdgeInput {
                edge_id: "nir1-edge".into(),
                from_entity_id: "nir1-alice".into(),
                to_entity_id: "nir1-bob".into(),
                relation_type: "knows".into(),
                directionality: "directed".into(),
                source_token: "v1@2026-09-12T00:00:00Z:relation:nir1-edge".into(),
                evidence_ids: vec!["nir1-evidence-alice".into(), "nir1-evidence-bob".into()],
            }],
        }
    }

    fn scope(authority_revision: String) -> ScopeBinding {
        ScopeBinding {
            reading: ScopeValue::Exact {
                value: "scene:nir1".into(),
            },
            story: ScopeValue::Any {
                purpose: Some("nir1-review".into()),
            },
            auto: ScopeValue::NotApplicable {
                reason: "review-input".into(),
            },
            phase: "draft".into(),
            reveal: "reader".into(),
            pov: None,
            authority_revision,
        }
    }

    fn seed_run_and_catalog(db: &crate::Database) -> anyhow::Result<()> {
        crate::narrative_extraction::narrative_extraction_create_run(
            db,
            CreateRunPayload {
                run_id: Some("nir1-run".into()),
                project_id: "default-project".into(),
                surface_path_id: "nir1.entity-relation".into(),
                scope_json: json!({}),
                spec_json: json!({}),
                spec_digest: "spec-nir1".into(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![],
            },
        )?;
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, content, sort_order)
                 VALUES ('nir1', 'default-project', 'scene', 'NIR1', '{}', 'a0')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                 VALUES ('nir1-alice', 'default-project', 'character', 'Alice', 'Alice', '2026-09-12T00:00:00Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                 VALUES ('nir1-bob', 'default-project', 'character', 'Bob', 'Bob', '2026-09-12T00:00:00Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_relations
                    (id, project_id, from_codex_id, to_codex_id, relation_type,
                     directionality, version, updated_at)
                 VALUES ('nir1-edge', 'default-project', 'nir1-alice', 'nir1-bob',
                         'knows', 'directed', 1, '2026-09-12T00:00:00Z')",
                [],
            )?;
            Ok(())
        })
    }

    fn request(db: &crate::Database) -> Nir1EntityRelationRevisionRequest {
        let authority_revision = db
            .with_read_transaction(|conn| {
                super::load_live_project_scope_authority(
                    conn,
                    "default-project",
                    "project:scope-authority:default-project",
                )
            })
            .expect("live fixture Scope authority");
        Nir1EntityRelationRevisionRequest {
            run_id: "nir1-run".into(),
            project_id: "default-project".into(),
            proposal_key: "nir1:review:1".into(),
            bundle: valid_bundle(
                "default-project",
                authority_revision.source.revision_token,
            ),
        }
    }

    #[test]
    fn typed_revision_is_native_bound_and_requires_explicit_human_approval() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let revision_id = created["revisionId"]
            .as_str()
            .expect("Native revision id")
            .to_owned();

        let before_approval = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        assert!(matches!(
            before_approval,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "revision-not-human-approved"
        ));

        narrative_extraction_append_human_decision(
            &db,
            AppendDecisionPayload {
                run_id: "nir1-run".into(),
                project_id: "default-project".into(),
                proposal_id: created["proposalId"].as_str().unwrap().into(),
                revision_id: revision_id.clone(),
                decision: "approved".into(),
                decision_json: None,
                created_by: Some("renderer-reviewer".into()),
            },
        )?;

        let reopened = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        match reopened {
            Nir1EntityRelationRevisionRead::Available(result) => {
                assert_eq!(result.revision_id, revision_id);
                assert_eq!(result.bundle.project_id, "default-project");
                assert_eq!(result.bundle.revision_id, result.revision_id);
                assert_eq!(result.bundle.entities.len(), 2);
                assert_eq!(result.bundle.relations.len(), 1);
                assert_eq!(
                    result.eligibility_source,
                    "nir1-entity-relation-eligibility-set"
                );
            }
            Nir1EntityRelationRevisionRead::Unavailable { reason } => {
                anyhow::bail!("approved typed revision unavailable: {reason}")
            }
        }

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE codex_entries
                    SET updated_at = '2026-09-12T00:01:00Z'
                  WHERE id = 'nir1-alice'",
                [],
            )?;
            Ok(())
        })?;
        let stale = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        assert!(matches!(
            stale,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "source-revision-changed"
        ));
        Ok(())
    }

    #[test]
    fn typed_revision_rejects_fake_or_cross_project_source_rows() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let mut payload = request(&db);
        payload.bundle.entities[0].source_token = "codex:nir1-alice@stale".into();
        let error = create_nir1_entity_relation_revision(&db, payload)
            .expect_err("source token must be tied to current Codex row");
        assert!(error.to_string().contains("NIR1_ENTITY_SOURCE_STALE"));

        let mut cross_project = request(&db);
        cross_project.bundle.project_id = "other-project".into();
        let error = create_nir1_entity_relation_revision(&db, cross_project)
            .expect_err("bundle project must match trusted project");
        assert!(error.to_string().contains("NIR1_ENTITY_PROJECT_MISMATCH"));
        Ok(())
    }

    #[test]
    fn generic_revision_append_cannot_mutate_a_typed_revision() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let error = narrative_extraction_append_revision(
            &db,
            AppendRevisionPayload {
                run_id: "nir1-run".into(),
                project_id: "default-project".into(),
                proposal_id: created["proposalId"].as_str().unwrap().into(),
                payload_json: json!({"kind":"mutation"}),
                reconciliation_envelope: None,
                inherit_reconciliation_envelope: None,
                expected_current_revision_id: created["revisionId"].as_str().unwrap().into(),
                created_by: None,
            },
        )
        .expect_err("typed revision is immutable");
        assert!(error
            .to_string()
            .contains("NIR1_ENTITY_RELATION_REVISION_IMMUTABLE"));
        Ok(())
    }

    #[test]
    fn generic_proposal_writer_cannot_create_the_reserved_typed_set() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        let error = narrative_extraction_save_proposal_set(
            &db,
            SaveProposalSetPayload {
                run_id: "nir1-run".into(),
                project_id: "default-project".into(),
                proposal_set_id: None,
                set_kind: NIR1_ENTITY_RELATION_SET_KIND.into(),
                summary_json: None,
                proposals: vec![],
            },
        )
        .expect_err("reserved typed set must use the Native adapter");
        assert!(error
            .to_string()
            .contains("NIR1_ENTITY_RELATION_TYPED_ADAPTER_REQUIRED"));
        Ok(())
    }

    #[test]
    fn typed_revision_binds_entity_type_to_the_live_codex_object() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let mut payload = request(&db);
        payload.bundle.entities[0].entity_type = "location".into();
        let error = create_nir1_entity_relation_revision(&db, payload)
            .expect_err("typed Entity type must match the live Codex object");
        assert!(error.to_string().contains("NIR1_ENTITY_TYPE_STALE"));
        Ok(())
    }

    #[test]
    fn typed_revision_rejects_a_quote_that_is_not_in_the_live_codex_text() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let mut payload = request(&db);
        payload.bundle.entities[0].evidence[0].quote = "Zebra".into();
        let error = create_nir1_entity_relation_revision(&db, payload)
            .expect_err("current source identity must not authorize a fabricated quote");
        assert!(error
            .to_string()
            .contains("NIR1_ENTITY_EVIDENCE_ANCHOR_MISMATCH"));
        Ok(())
    }

    #[test]
    fn typed_revision_accepts_nonzero_utf16_evidence_after_a_surrogate_prefix() -> anyhow::Result<()>
    {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE codex_entries SET summary = ?1 WHERE id = 'nir1-alice'",
                ["😀Alice waits"],
            )?;
            Ok(())
        })?;

        let mut payload = request(&db);
        payload.bundle.entities[0].evidence[0].start_utf16 = 2;
        payload.bundle.entities[0].evidence[0].end_utf16 = 7;
        payload.bundle.entities[0].evidence[0].quote = "Alice".into();
        create_nir1_entity_relation_revision(&db, payload)
            .expect("an exact non-zero UTF-16 source range must be accepted");
        Ok(())
    }

    #[test]
    fn typed_revision_rejects_unknown_and_stale_scope_bindings() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;

        let mut unknown_scope = request(&db);
        unknown_scope.bundle.entities[0].scope.reading = ScopeValue::Exact {
            value: "scene:not-live".into(),
        };
        let error = create_nir1_entity_relation_revision(&db, unknown_scope)
            .expect_err("unknown Scope references must not be persisted");
        assert!(error
            .to_string()
            .contains("NIR1_SCOPE_REFERENCE_UNAVAILABLE"));

        let mut stale_scope = request(&db);
        stale_scope.bundle.entities[0].scope.authority_revision =
            format!("sha256:{}", "a".repeat(64));
        let error = create_nir1_entity_relation_revision(&db, stale_scope)
            .expect_err("Scope revision must be bound to the live authority");
        assert!(error.to_string().contains("NIR1_SCOPE_AUTHORITY_STALE"));
        Ok(())
    }

    #[test]
    fn typed_revision_reopen_is_invalidated_by_scope_authority_change() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let revision_id = created["revisionId"].as_str().unwrap().to_owned();
        narrative_extraction_append_human_decision(
            &db,
            AppendDecisionPayload {
                run_id: "nir1-run".into(),
                project_id: "default-project".into(),
                proposal_id: created["proposalId"].as_str().unwrap().into(),
                revision_id: revision_id.clone(),
                decision: "approved".into(),
                decision_json: None,
                created_by: Some("renderer-reviewer".into()),
            },
        )?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes
                    SET story_time_order = 'story-nir1'
                  WHERE id = 'nir1' AND project_id = 'default-project'",
                [],
            )?;
            Ok(())
        })?;
        let reopened = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        assert!(matches!(
            reopened,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "source-revision-changed"
        ));
        Ok(())
    }

    #[test]
    fn generic_review_bundle_does_not_publish_typed_evidence() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let error = super::super::repository::get_run_review_bundle(
            &db,
            "nir1-run".into(),
            "default-project".into(),
        )
        .expect_err("generic review bundle must not expose typed Evidence plaintext");
        assert!(error
            .to_string()
            .contains("NIR1_ENTITY_RELATION_REVIEW_BUNDLE_UNAVAILABLE"));
        assert!(created["revisionId"].as_str().is_some());
        Ok(())
    }

    #[test]
    fn renderer_sql_cannot_read_typed_revision_payloads_from_either_table() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let revision_id = created["revisionId"].as_str().unwrap().to_owned();
        let proposal_id = created["proposalId"].as_str().unwrap().to_owned();

        for (table, id) in [
            ("narrative_proposals", proposal_id.as_str()),
            ("narrative_proposal_revisions", revision_id.as_str()),
        ] {
            let error = db
                .execute_renderer(
                    &format!("SELECT payload_json FROM {table} WHERE id = ?1"),
                    &[json!(id)],
                    "get",
                )
                .expect_err("renderer db_execute must not expose typed Evidence");
            assert!(
                error
                    .to_string()
                    .contains("RENDERER_SQL_TYPED_PAYLOAD"),
                "unexpected single-statement error for {table}: {error}"
            );

            let error = db
                .execute_batch_tx_renderer(&[crate::BatchStatement {
                    sql: format!("SELECT payload_json FROM {table} WHERE id = ?1"),
                    params: vec![json!(id)],
                    method: "get".into(),
                }])
                .expect_err("renderer db_execute_batch must not expose typed Evidence");
            assert!(
                error
                    .to_string()
                    .contains("RENDERER_SQL_TYPED_PAYLOAD"),
                "unexpected batch error for {table}: {error}"
            );
        }
        Ok(())
    }

    #[test]
    fn typed_reader_requires_a_read_transaction() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        let error = db
            .with_conn(|conn| read_nir1_entity_relation_revision(conn, "default-project", "r"))
            .expect_err("autocommit reader must be rejected");
        assert!(error
            .to_string()
            .contains("NIR1_ENTITY_RELATION_REQUIRES_READ_TRANSACTION"));
        Ok(())
    }
}
