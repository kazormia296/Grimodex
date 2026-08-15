//! Native-owned field authority for narrative Apply operations.
//!
//! The renderer may describe a review decision, but it cannot choose the
//! authority that the decision receives. Native derives that authority from
//! the endpoint context and only then validates the small structured override
//! vocabulary. `created_by`, `actorKind`, and `authorityScope` are audit/UI
//! metadata; none of them is an actor credential.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use uuid::Uuid;

use super::codex_operations::{
    parse_entity_bind_existing_payload, parse_entry_create_payload, parse_entry_patch_payload,
    parse_relation_create_payload, CommitMap,
};
use super::detail_operations::parse_detail_value_set_payload;
use super::foreshadow_operations::{
    parse_create as parse_foreshadow_create, parse_patch as parse_foreshadow_patch,
};
use super::models::{CommitOperation, HumanFieldLockPayload};
use super::phase_operations::{parse_phase_create_payload, parse_phase_patch_payload};
use super::plot_thread_operations::{
    parse_plot_branch_create_payload, parse_plot_marker_create_payload,
    parse_plot_thread_create_payload, parse_plot_thread_patch_payload,
};
use super::semantic_bindings::parse_semantic_binding_upsert_payload;
use super::temporal_constraints::parse_constraint_create_payload;
use super::temporal_nodes::parse_node_ensure_payload;
use super::temporal_operations::{
    parse_event_metadata_patch_payload, parse_scene_metadata_patch_payload,
    parse_story_order_materialize_payload,
};
use super::temporal_projections::parse_projection_record_payload;
use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};

fn json_pointer_segment(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TrustedDecisionActor {
    Human {
        actor_id: String,
    },
    /// The automated endpoint has no human authority, regardless of what the
    /// renderer puts in `createdBy`.
    Automated {
        actor_id: String,
    },
}

impl TrustedDecisionActor {
    fn kind(&self) -> &'static str {
        match self {
            Self::Human { .. } => "human",
            Self::Automated { .. } => "ai",
        }
    }

    fn actor_id(&self) -> &str {
        match self {
            Self::Human { actor_id } | Self::Automated { actor_id } => actor_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DecisionAuthority {
    pub actor_kind: String,
    pub actor_id: String,
    pub authority_scope: String,
    pub override_field_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AffectedField {
    pub entity_kind: String,
    pub entity_id: String,
    pub field_path: String,
}

pub(crate) fn record_human_field_write(
    conn: &Connection,
    project_id: &str,
    entity_kind: &str,
    entity_id: &str,
    field_paths: &[&str],
    updated_at: &str,
) -> anyhow::Result<()> {
    for field_path in field_paths {
        anyhow::ensure!(
            is_exact_field_path(field_path),
            "NEX_FIELD_AUTHORITY_PATH_INVALID: manual writer supplied an invalid field path"
        );
        conn.execute(
            "INSERT INTO narrative_field_authority
                (project_id, entity_kind, entity_id, field_path, owner_kind,
                 explicit_lock, version, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'human', 0, 0, ?5)
             ON CONFLICT(project_id, entity_kind, entity_id, field_path)
             DO UPDATE SET owner_kind = 'human',
                 version = narrative_field_authority.version + 1,
                 updated_at = excluded.updated_at",
            params![project_id, entity_kind, entity_id, field_path, updated_at],
        )?;
    }
    Ok(())
}

pub(crate) fn set_human_field_lock_in_tx(
    conn: &Connection,
    payload: &HumanFieldLockPayload,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !payload.project_id.trim().is_empty()
            && !payload.entity_kind.trim().is_empty()
            && !payload.entity_id.trim().is_empty(),
        "NEX_FIELD_AUTHORITY_LOCK_INVALID: project/entity identity is required"
    );
    anyhow::ensure!(
        is_exact_field_path(&payload.field_path),
        "NEX_FIELD_AUTHORITY_LOCK_INVALID: fieldPath must be an exact JSON pointer"
    );
    anyhow::ensure!(
        payload.expected_version >= 0,
        "NEX_FIELD_AUTHORITY_LOCK_INVALID: expectedVersion must be non-negative"
    );
    let updated_at = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let updated = conn.execute(
        "UPDATE narrative_field_authority
            SET owner_kind = 'human', explicit_lock = ?1,
                version = version + 1, updated_at = ?2
          WHERE project_id = ?3 AND entity_kind = ?4 AND entity_id = ?5
            AND field_path = ?6 AND version = ?7",
        params![
            if payload.locked { 1 } else { 0 },
            updated_at,
            payload.project_id,
            payload.entity_kind,
            payload.entity_id,
            payload.field_path,
            payload.expected_version,
        ],
    )?;
    if updated == 0 {
        let current_version: Option<i64> = conn
            .query_row(
                "SELECT version FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = ?2
                    AND entity_id = ?3 AND field_path = ?4",
                params![
                    payload.project_id,
                    payload.entity_kind,
                    payload.entity_id,
                    payload.field_path,
                ],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(current_version) = current_version {
            anyhow::bail!(
                "NEX_FIELD_AUTHORITY_LOCK_CONFLICT: expected version {} but field is at {}",
                payload.expected_version,
                current_version
            );
        }
        anyhow::ensure!(
            payload.expected_version == 0,
            "NEX_FIELD_AUTHORITY_LOCK_CONFLICT: expected version {} does not match missing field",
            payload.expected_version
        );
        conn.execute(
            "INSERT INTO narrative_field_authority
                (project_id, entity_kind, entity_id, field_path, owner_kind,
                 explicit_lock, version, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'human', ?5, 1, ?6)",
            params![
                payload.project_id,
                payload.entity_kind,
                payload.entity_id,
                payload.field_path,
                if payload.locked { 1 } else { 0 },
                updated_at,
            ],
        )?;
    }
    let version: i64 = conn.query_row(
        "SELECT version FROM narrative_field_authority
          WHERE project_id = ?1 AND entity_kind = ?2 AND entity_id = ?3 AND field_path = ?4",
        params![
            payload.project_id,
            payload.entity_kind,
            payload.entity_id,
            payload.field_path,
        ],
        |row| row.get(0),
    )?;
    Ok(serde_json::json!({
        "projectId": payload.project_id,
        "entityKind": payload.entity_kind,
        "entityId": payload.entity_id,
        "fieldPath": payload.field_path,
        "locked": payload.locked,
        "version": version,
    }))
}

/// Mark immutable application dependencies stale after a trusted source write.
/// This only changes freshness/provenance state and emits a reconciliation
/// signal; it never writes a projection or any domain aggregate.
pub(crate) fn propagate_source_change_freshness_in_tx(
    conn: &Connection,
    project_id: &str,
    source_kind: &str,
    source_key: &str,
    current_revision_token: Option<&str>,
    updated_at: &str,
    session_id: &str,
) -> anyhow::Result<usize> {
    let mut statement = conn.prepare(
        "SELECT d.application_id, d.observed_revision_token
           FROM narrative_projection_dependencies d
           INNER JOIN narrative_proposal_applications a ON a.id = d.application_id
           INNER JOIN narrative_apply_commits c ON c.id = a.commit_id
          WHERE c.project_id = ?1 AND d.source_kind = ?2 AND d.source_key = ?3",
    )?;
    let rows = statement
        .query_map(params![project_id, source_kind, source_key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    let mut events = Vec::new();
    for (application_id, observed_token) in rows {
        let (status, reason) = match current_revision_token {
            Some(current) if current == observed_token => continue,
            Some(current) => (
                "stale",
                serde_json::json!({
                    "sourceKind": source_kind,
                    "sourceKey": source_key,
                    "observedRevisionToken": observed_token,
                    "currentRevisionToken": current,
                    "propagation": "needs-reconciliation",
                }),
            ),
            None => (
                "source-missing",
                serde_json::json!({
                    "sourceKind": source_kind,
                    "sourceKey": source_key,
                    "observedRevisionToken": observed_token,
                    "propagation": "needs-reconciliation",
                }),
            ),
        };
        conn.execute(
            "UPDATE narrative_projection_freshness
                SET status = ?1, reason_json = ?2,
                    version = version + 1, updated_at = ?3
              WHERE application_id = ?4",
            params![status, reason.to_string(), updated_at, application_id],
        )?;
        events.push(AppendChangeEvent {
            event_uid: Uuid::new_v4().to_string(),
            scene_id: None,
            domain: "narrative".to_string(),
            op_type: "needs-reconciliation".to_string(),
            entity_type: Some("narrative-application".to_string()),
            entity_id: Some(application_id),
            payload: reason.to_string(),
            timestamp: chrono::DateTime::parse_from_rfc3339(updated_at)
                .map(|value| value.timestamp_millis())
                .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis()),
        });
    }
    if !events.is_empty() {
        append_change_events_in_tx(conn, project_id, session_id, &events)?;
    }
    Ok(events.len())
}

pub(crate) fn derive_decision_authority(
    actor: &TrustedDecisionActor,
    project_id: &str,
    proposal_id: &str,
    revision_id: &str,
    decision_json: &Value,
) -> anyhow::Result<DecisionAuthority> {
    let actor_kind = actor.kind().to_string();
    if let Some(declared) = decision_json.get("actorKind").and_then(Value::as_str) {
        anyhow::ensure!(
            declared == actor_kind,
            "NEX_AUTHORITY_ACTOR_MISMATCH: declared actorKind does not match trusted endpoint context"
        );
    }
    let actor_id = actor.actor_id().trim();
    anyhow::ensure!(
        !actor_id.is_empty(),
        "NEX_AUTHORITY_ACTOR_MISSING: trusted actor identity is required"
    );
    anyhow::ensure!(
        !project_id.trim().is_empty(),
        "NEX_AUTHORITY_SCOPE_INVALID: project is required"
    );
    anyhow::ensure!(
        !proposal_id.trim().is_empty(),
        "NEX_AUTHORITY_SCOPE_INVALID: proposal is required"
    );
    anyhow::ensure!(
        !revision_id.trim().is_empty(),
        "NEX_AUTHORITY_SCOPE_INVALID: revision is required"
    );
    let authority_scope =
        format!("project/{project_id}/proposal/{proposal_id}/revision/{revision_id}");
    if let Some(declared_scope) = decision_json.get("authorityScope").and_then(Value::as_str) {
        anyhow::ensure!(
            declared_scope == authority_scope,
            "NEX_AUTHORITY_SCOPE_MISMATCH: authorityScope is derived by Native"
        );
    }
    anyhow::ensure!(
        authority_scope.split('/').count() == 6,
        "NEX_AUTHORITY_SCOPE_INVALID: scope must be project/proposal/revision scoped"
    );

    if decision_json.get("override").and_then(Value::as_bool) == Some(true) {
        anyhow::bail!(
            "NEX_AUTHORITY_OVERRIDE_UNTRUSTED: boolean override is not an authority grant"
        );
    }
    let mut override_field_paths = Vec::new();
    if let Some(raw_paths) = decision_json.get("overrideFieldPaths") {
        let paths = raw_paths.as_array().ok_or_else(|| {
            anyhow::anyhow!("NEX_AUTHORITY_OVERRIDE_INVALID: overrideFieldPaths must be an array")
        })?;
        for raw_path in paths {
            let path = raw_path.as_str().ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_AUTHORITY_OVERRIDE_INVALID: overrideFieldPaths entries must be strings"
                )
            })?;
            anyhow::ensure!(
                is_exact_field_path(path),
                "NEX_AUTHORITY_OVERRIDE_INVALID: overrideFieldPaths must contain exact JSON pointers"
            );
            if !override_field_paths.iter().any(|existing| existing == path) {
                override_field_paths.push(path.to_string());
            }
        }
    }
    override_field_paths.sort();
    anyhow::ensure!(
        actor_kind == "human" || override_field_paths.is_empty(),
        "NEX_AUTHORITY_OVERRIDE_FORBIDDEN: only human decisions may carry field overrides"
    );

    Ok(DecisionAuthority {
        actor_kind,
        actor_id: actor_id.to_string(),
        authority_scope,
        override_field_paths,
    })
}

pub(crate) fn load_decision_authority(
    conn: &Connection,
    proposal_id: &str,
    revision_id: &str,
) -> anyhow::Result<DecisionAuthority> {
    let row: (String, String, String, String) = conn.query_row(
        "SELECT actor_kind, actor_id, authority_scope, override_field_paths_json
           FROM narrative_proposal_decisions
          WHERE proposal_id = ?1 AND revision_id = ?2
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1",
        params![proposal_id, revision_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let raw_paths: Value = serde_json::from_str(&row.3).map_err(|error| {
        anyhow::anyhow!(
            "NEX_AUTHORITY_STORAGE_INVALID: override field paths are not valid JSON: {error}"
        )
    })?;
    let paths = raw_paths.as_array().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_AUTHORITY_STORAGE_INVALID: override field paths must be stored as an array"
        )
    })?;
    let mut override_field_paths = Vec::with_capacity(paths.len());
    for path in paths {
        let path = path.as_str().ok_or_else(|| {
            anyhow::anyhow!("NEX_AUTHORITY_STORAGE_INVALID: override path is not a string")
        })?;
        anyhow::ensure!(
            is_exact_field_path(path),
            "NEX_AUTHORITY_STORAGE_INVALID: stored override path is not exact"
        );
        override_field_paths.push(path.to_string());
    }
    anyhow::ensure!(
        matches!(row.0.as_str(), "human" | "ai" | "system" | "unknown"),
        "NEX_AUTHORITY_STORAGE_INVALID: actor kind is unknown"
    );
    anyhow::ensure!(
        row.1.trim() != "" && row.2.trim() != "",
        "NEX_AUTHORITY_STORAGE_INVALID: actor identity or scope is empty"
    );
    anyhow::ensure!(
        row.0 == "human" || override_field_paths.is_empty(),
        "NEX_AUTHORITY_STORAGE_INVALID: non-human actor has an override grant"
    );
    Ok(DecisionAuthority {
        actor_kind: row.0,
        actor_id: row.1,
        authority_scope: row.2,
        override_field_paths,
    })
}

/// Typed, fail-closed field coverage for every operation accepted by
/// `commit.rs`. Keeping this table beside the typed parsers prevents a new
/// writer from silently getting an empty authority set.
pub(crate) fn affected_fields(
    operation: &CommitOperation,
    commit_map: &CommitMap,
) -> anyhow::Result<Vec<AffectedField>> {
    let payload = &operation.payload;
    let mut fields = Vec::new();
    match operation.kind.as_str() {
        "chronicle.event.create" => {
            let value = super::chronicle_operations::parse_event_create_payload(payload)?;
            fields = fields_for(
                "event",
                &value.event_id,
                &[
                    "/title",
                    "/note",
                    "/kind",
                    "/precision",
                    "/ordinal",
                    "/secret",
                    "/revealSceneId",
                    "/evidenceSceneLinks",
                    "/detail",
                    "/primaryCodexId",
                    "/locationCodexId",
                    "/participants",
                    "/startTime",
                    "/endTime",
                    "/startMinute",
                    "/endMinute",
                    "/startGranularity",
                    "/endGranularity",
                ],
            );
        }
        "codex.entry.create" => {
            let value = parse_entry_create_payload(payload)?;
            fields = fields_for(
                "codex-entry",
                &value.entry_id,
                &[
                    "/name",
                    "/summary",
                    "/aliases",
                    "/type",
                    "/content",
                    "/parentId",
                ],
            );
        }
        "codex.entry.patch" => {
            let value = parse_entry_patch_payload(payload)?;
            if value
                .name
                .as_ref()
                .is_some_and(|patch| patch.kind != "leave")
            {
                fields.push(field("codex-entry", &value.entry_id, "/name"));
            }
            if value
                .summary
                .as_ref()
                .is_some_and(|patch| patch.kind != "leave")
            {
                fields.push(field("codex-entry", &value.entry_id, "/summary"));
            }
            if value
                .aliases
                .as_ref()
                .is_some_and(|patch| patch.kind != "leave")
            {
                fields.push(field("codex-entry", &value.entry_id, "/aliases"));
            }
            if value
                .type_slug
                .as_ref()
                .is_some_and(|patch| patch.kind != "leave")
            {
                fields.push(field("codex-entry", &value.entry_id, "/type"));
            }
            if value
                .parent_id
                .as_ref()
                .is_some_and(|patch| patch.kind != "leave")
            {
                fields.push(field("codex-entry", &value.entry_id, "/parentId"));
            }
        }
        "codex.entity.bind-existing" => {
            let value = parse_entity_bind_existing_payload(payload)?;
            fields.push(field("codex-entry", &value.entry_id, "/narrativeEntityId"));
        }
        "codex.relation.create" => {
            let value = parse_relation_create_payload(payload)?;
            fields = fields_for(
                "codex-relation",
                &value.relation_id,
                &[
                    "/fromCodexId",
                    "/toCodexId",
                    "/relationType",
                    "/directionality",
                    "/forwardLabel",
                    "/inverseLabel",
                    "/semanticKey",
                ],
            );
        }
        "codex.detail.value.set" => {
            let value = parse_detail_value_set_payload(payload)?;
            let entry_id = value
                .entry_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    value
                        .narrative_entity_id
                        .as_deref()
                        .and_then(|id| commit_map.resolve(id).ok())
                        .map(|binding| binding.codex_entry_id.clone())
                })
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_FIELD_AUTHORITY_PAYLOAD_INVALID: detail value target is not bound"
                    )
                })?;
            fields.push(field(
                "codex-entry",
                &entry_id,
                &format!("/details/{}", json_pointer_segment(&value.definition_id)),
            ));
        }
        "codex.phase.create" => {
            let value = parse_phase_create_payload(payload)?;
            fields = fields_for(
                "codex-phase",
                &value.phase_id,
                &[
                    "/label",
                    "/summaryOverride",
                    "/detailOverrides",
                    "/entryId",
                    "/anchorNodeId",
                ],
            );
            for item in &value.detail_overrides {
                fields.push(field(
                    "codex-phase",
                    &value.phase_id,
                    &format!("/details/{}", json_pointer_segment(&item.definition_id)),
                ));
            }
        }
        "codex.phase.patch" => {
            let value = parse_phase_patch_payload(payload)?;
            if value.label.is_some() {
                fields.push(field("codex-phase", &value.phase_id, "/label"));
            }
            if !matches!(
                value.summary,
                super::phase_operations::PhaseSummaryPatch::Leave
            ) {
                fields.push(field("codex-phase", &value.phase_id, "/summaryOverride"));
            }
            // The typed writer replaces the complete collection, including an
            // empty vector (which deletes old overrides).
            fields.push(field("codex-phase", &value.phase_id, "/detailOverrides"));
            for item in &value.detail_overrides {
                fields.push(field(
                    "codex-phase",
                    &value.phase_id,
                    &format!("/details/{}", json_pointer_segment(&item.definition_id)),
                ));
            }
        }
        "codex.semantic_binding.upsert" => {
            let value = parse_semantic_binding_upsert_payload(payload)?;
            fields = fields_for(
                "codex-detail-semantic-binding",
                &value.binding_id,
                &[
                    "/definitionId",
                    "/facetKey",
                    "/projectionKind",
                    "/temporalPolicy",
                    "/source",
                    "/confirmed",
                ],
            );
        }
        "temporal.node.ensure" => {
            let value = parse_node_ensure_payload(payload)?;
            fields = fields_for(
                "temporal-node",
                &value.node_id,
                &["/timelineKind", "/timelineKey", "/subject", "/shape"],
            );
        }
        "temporal.constraint.create" => {
            let value = parse_constraint_create_payload(payload)?;
            let id = value.authority_entity_id();
            fields = fields_for(
                "temporal-constraint",
                &id,
                &[
                    "/kind",
                    "/nodes",
                    "/literal",
                    "/resolved",
                    "/authority",
                    "/strictness",
                    "/sourceIds",
                    "/fingerprint",
                ],
            );
        }
        "temporal.scene.metadata.patch" => {
            let value = parse_scene_metadata_patch_payload(payload)?;
            fields = temporal_typed_fields("scene", &value.target_id);
        }
        "temporal.event.metadata.patch" => {
            let value = parse_event_metadata_patch_payload(payload)?;
            fields = temporal_typed_fields("event", &value.target_id);
        }
        "temporal.story-order.materialize" => {
            let value = parse_story_order_materialize_payload(payload)?;
            fields.push(field("scene", &value.scene_id, "/storyTimeOrder"));
            if value.story_time_label.is_some() {
                fields.push(field("scene", &value.scene_id, "/storyTimeLabel"));
            }
        }
        "temporal.projection.record" => {
            let value = parse_projection_record_payload(payload)?;
            let id = value
                .projection_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .unwrap_or(&value.target_id);
            fields = fields_for(
                "temporal-projection",
                id,
                &[
                    "/targetKind",
                    "/targetId",
                    "/constraintSetDigest",
                    "/solverVersion",
                    "/calendarDigest",
                    "/projectedValueDigest",
                    "/targetResultVersion",
                    "/applicationId",
                    "/status",
                ],
            );
        }
        "plot.thread.create" => {
            let value = parse_plot_thread_create_payload(payload)?;
            fields = fields_for(
                "plot-thread",
                &value.thread_id,
                &[
                    "/name",
                    "/description",
                    "/color",
                    "/sortOrder",
                    "/hypothesisId",
                ],
            );
        }
        "plot.thread.patch" => {
            let value = parse_plot_thread_patch_payload(payload)?;
            for (patch, path) in [
                (value.name.as_ref(), "/name"),
                (value.description.as_ref(), "/description"),
                (value.color.as_ref(), "/color"),
                (value.sort_order.as_ref(), "/sortOrder"),
                (value.start_node_id.as_ref(), "/startNodeId"),
                (value.end_node_id.as_ref(), "/endNodeId"),
            ] {
                if patch.is_some_and(|value| value.kind != "leave") {
                    fields.push(field("plot-thread", &value.thread_id, path));
                }
            }
        }
        "plot.marker.create" => {
            let value = parse_plot_marker_create_payload(payload)?;
            fields = fields_for(
                "plot-marker",
                &value.marker_id,
                &[
                    "/threadId",
                    "/sceneId",
                    "/phaseType",
                    "/note",
                    "/semanticKey",
                    "/hypothesisId",
                ],
            );
        }
        "plot.branch.create" => {
            let value = parse_plot_branch_create_payload(payload)?;
            fields = fields_for(
                "plot-branch",
                &value.branch_id,
                &[
                    "/fromThreadId",
                    "/toThreadId",
                    "/atSceneId",
                    "/kind",
                    "/semanticKey",
                    "/fromHypothesisId",
                    "/toHypothesisId",
                ],
            );
        }
        "foreshadow.aggregate.create" => {
            let value = parse_foreshadow_create(payload)?;
            fields = fields_for(
                "foreshadow",
                &value.foreshadow_id,
                &[
                    "/title",
                    "/intent",
                    "/mechanism",
                    "/secret",
                    "/setups",
                    "/payoffs",
                    "/supportEdges",
                    "/codexEntryIds",
                ],
            );
        }
        "foreshadow.aggregate.patch" => {
            let value = parse_foreshadow_patch(payload)?;
            if value
                .intent
                .as_ref()
                .is_some_and(|patch| patch.kind != "leave")
            {
                fields.push(field("foreshadow", &value.foreshadow_id, "/intent"));
            }
            if value
                .mechanism
                .as_ref()
                .is_some_and(|patch| patch.kind != "leave")
            {
                fields.push(field("foreshadow", &value.foreshadow_id, "/mechanism"));
            }
            if !value.add_setups.is_empty() {
                fields.push(field("foreshadow", &value.foreshadow_id, "/setups"));
            }
            if !value.add_payoffs.is_empty() {
                fields.push(field("foreshadow", &value.foreshadow_id, "/payoffs"));
            }
            if !value.add_support_edges.is_empty() {
                fields.push(field("foreshadow", &value.foreshadow_id, "/supportEdges"));
            }
            if !value.add_codex_entry_ids.is_empty() {
                fields.push(field("foreshadow", &value.foreshadow_id, "/codexEntryIds"));
            }
        }
        other => anyhow::bail!(
            "NEX_FIELD_AUTHORITY_OPERATION_UNMAPPED: no typed field map for '{other}'"
        ),
    }
    anyhow::ensure!(
        !fields.is_empty(),
        "NEX_FIELD_AUTHORITY_OPERATION_EMPTY: '{}' affected no fields",
        operation.kind
    );
    Ok(fields)
}

fn field(entity_kind: &str, entity_id: &str, field_path: &str) -> AffectedField {
    AffectedField {
        entity_kind: entity_kind.to_string(),
        entity_id: entity_id.to_string(),
        field_path: field_path.to_string(),
    }
}

fn fields_for(entity_kind: &str, entity_id: &str, paths: &[&str]) -> Vec<AffectedField> {
    paths
        .iter()
        .map(|path| field(entity_kind, entity_id, path))
        .collect()
}

fn temporal_typed_fields(entity_kind: &str, entity_id: &str) -> Vec<AffectedField> {
    fields_for(
        entity_kind,
        entity_id,
        &[
            "/startTime",
            "/startMinute",
            "/startGranularity",
            "/endTime",
            "/endMinute",
            "/endGranularity",
            "/precision",
        ],
    )
}

pub(crate) fn validate_operation_field_authority(
    conn: &Connection,
    project_id: &str,
    applications: &[(String, String)],
    operations: &[CommitOperation],
    commit_map: &CommitMap,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        applications.len() == operations.len(),
        "NEX_FIELD_AUTHORITY_OPERATION_MISMATCH: applications and operations must align"
    );
    for (operation, (proposal_id, revision_id)) in operations.iter().zip(applications) {
        let authority = load_decision_authority(conn, proposal_id, revision_id)?;
        for field in affected_fields(operation, commit_map)? {
            let owned: Option<(String, i64)> = conn
                .query_row(
                    "SELECT owner_kind, explicit_lock
                       FROM narrative_field_authority
                      WHERE project_id = ?1 AND entity_kind = ?2
                        AND entity_id = ?3 AND field_path = ?4",
                    params![
                        project_id,
                        field.entity_kind,
                        field.entity_id,
                        field.field_path
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let legacy_human = owned.is_none()
                && legacy_value_present(
                    conn,
                    project_id,
                    &field.entity_kind,
                    &field.entity_id,
                    &field.field_path,
                )?;
            let explicitly_locked = owned
                .as_ref()
                .is_some_and(|(_, explicit_lock)| *explicit_lock != 0);
            let human_owned =
                owned.as_ref().is_some_and(|(owner, _)| owner == "human") || legacy_human;
            let exact_override = authority
                .override_field_paths
                .iter()
                .any(|path| path == &field.field_path);
            let denied = if explicitly_locked {
                authority.actor_kind != "human" || !exact_override
            } else {
                human_owned && authority.actor_kind != "human"
            };
            if denied {
                anyhow::bail!(
                    "NEX_FIELD_AUTHORITY_DENIED: '{}' on {} '{}' is human-owned or locked",
                    field.field_path,
                    field.entity_kind,
                    field.entity_id
                );
            }
        }
    }
    Ok(())
}

pub(crate) fn record_operation_field_authority(
    conn: &Connection,
    project_id: &str,
    applications: &[(String, String)],
    operations: &[CommitOperation],
    updated_at: &str,
    commit_map: &CommitMap,
) -> anyhow::Result<()> {
    for (operation, (proposal_id, revision_id)) in operations.iter().zip(applications) {
        let authority = load_decision_authority(conn, proposal_id, revision_id)?;
        for field in affected_fields(operation, commit_map)? {
            conn.execute(
                "INSERT INTO narrative_field_authority
                    (project_id, entity_kind, entity_id, field_path, owner_kind,
                     explicit_lock, version, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6)
                 ON CONFLICT(project_id, entity_kind, entity_id, field_path)
                 DO UPDATE SET owner_kind = CASE
                         WHEN narrative_field_authority.owner_kind = 'human'
                         THEN 'human' ELSE excluded.owner_kind END,
                     version = narrative_field_authority.version + 1,
                     updated_at = excluded.updated_at",
                params![
                    project_id,
                    field.entity_kind,
                    field.entity_id,
                    field.field_path,
                    authority.actor_kind,
                    updated_at,
                ],
            )?;
        }
    }
    Ok(())
}

fn is_exact_field_path(path: &str) -> bool {
    !path.is_empty()
        && path.starts_with('/')
        && !path.contains('*')
        && !path.contains("//")
        && !path.ends_with('/')
}

pub(crate) fn legacy_value_present(
    conn: &Connection,
    project_id: &str,
    entity_kind: &str,
    entity_id: &str,
    field_path: &str,
) -> anyhow::Result<bool> {
    let association_sql = match (entity_kind, field_path) {
        ("event", "/participants") => Some(
            "SELECT EXISTS(
                 SELECT 1
                   FROM event_participants participant
                   JOIN events event ON event.id = participant.event_id
                  WHERE participant.event_id = ?1 AND event.project_id = ?2
             )",
        ),
        ("event", "/sceneIds") => Some(
            "SELECT EXISTS(
                 SELECT 1
                   FROM scene_events scene_event
                   JOIN events event ON event.id = scene_event.event_id
                  WHERE scene_event.event_id = ?1 AND event.project_id = ?2
             )",
        ),
        ("event", "/relations") => Some(
            "SELECT EXISTS(
                 SELECT 1 FROM event_relations relation
                  WHERE relation.project_id = ?2
                    AND (relation.cause_event_id = ?1 OR relation.effect_event_id = ?1)
             )",
        ),
        _ => None,
    };
    if let Some(sql) = association_sql {
        return Ok(conn.query_row(sql, params![entity_id, project_id], |row| row.get(0))?);
    }

    let legacy_field = match (entity_kind, field_path) {
        ("codex-entry", "/name") => Some(("codex_entries", "name", "text")),
        ("codex-entry", "/summary") => Some(("codex_entries", "summary", "text")),
        ("codex-entry", "/content") => Some(("codex_entries", "content", "text")),
        ("codex-entry", "/aliases") => Some(("codex_entries", "aliases", "text")),
        ("codex-entry", "/excludedAliases") => {
            Some(("codex_entries", "excluded_aliases", "text"))
        }
        ("codex-entry", "/readings") => Some(("codex_entries", "readings", "text")),
        ("codex-entry", "/tagsCache") => Some(("codex_entries", "tags_cache", "text")),
        ("codex-entry", "/type") => Some(("codex_entries", "type", "text")),
        ("codex-entry", "/parentId") => Some(("codex_entries", "parent_id", "text")),
        ("codex-entry", "/contextMode") => Some(("codex_entries", "context_mode", "text")),
        ("codex-entry", "/icon") => Some(("codex_entries", "icon", "text")),
        ("codex-entry", "/childrenBudget") => {
            Some(("codex_entries", "children_budget", "text"))
        }
        ("codex-entry", "/notes") => Some(("codex_entries", "notes", "text")),
        ("event", "/title") => Some(("events", "title", "text")),
        ("event", "/note") => Some(("events", "note", "text")),
        ("event", "/detail") => Some(("events", "detail", "text")),
        ("event", "/ordinal") => Some(("events", "ordinal", "text")),
        ("event", "/laneGroup") => Some(("events", "lane_group", "text")),
        ("event", "/precision") => Some(("events", "precision", "text")),
        ("event", "/kind") => Some(("events", "kind", "text")),
        ("event", "/primaryCodexId") => Some(("events", "primary_codex_id", "text")),
        ("event", "/locationCodexId") => Some(("events", "location_codex_id", "text")),
        ("event", "/revealSceneId") => Some(("events", "reveal_scene_id", "text")),
        ("event", "/startTime") => Some(("events", "start_time", "present")),
        ("event", "/endTime") => Some(("events", "end_time", "present")),
        ("event", "/startMinute") => Some(("events", "start_minute", "present")),
        ("event", "/endMinute") => Some(("events", "end_minute", "present")),
        ("event", "/startGranularity") => {
            Some(("events", "start_granularity", "text"))
        }
        ("event", "/endGranularity") => Some(("events", "end_granularity", "text")),
        ("event", "/secret") => Some(("events", "secret", "boolean")),
        ("foreshadow", "/title") => Some(("foreshadows", "title", "text")),
        ("foreshadow", "/intent") => Some(("foreshadows", "intent", "text")),
        ("foreshadow", "/notes") => Some(("foreshadows", "notes", "text")),
        ("foreshadow", "/loadBearing") => Some(("foreshadows", "load_bearing", "text")),
        ("foreshadow", "/payoffSceneId") => {
            Some(("foreshadows", "payoff_scene_id", "text"))
        }
        ("foreshadow", "/payoffFromPos") => {
            Some(("foreshadows", "payoff_from_pos", "present"))
        }
        ("foreshadow", "/payoffToPos") => {
            Some(("foreshadows", "payoff_to_pos", "present"))
        }
        ("foreshadow", "/payoffConfirmed") => {
            Some(("foreshadows", "payoff_confirmed", "boolean"))
        }
        ("foreshadow", "/abandoned") => Some(("foreshadows", "abandoned", "boolean")),
        ("foreshadow", "/secret") => Some(("foreshadows", "secret", "boolean")),
        // Tree nodes predate Field Authority rows. An existing row is the
        // legacy human snapshot, including NULL-valued fields such as a
        // root's parentId or an empty synopsis, so presence of the node—not
        // presence of one column value—is the fail-closed signal.
        ("tree_node" | "scene", "/parentId") => Some(("tree_nodes", "id", "row")),
        ("tree_node" | "scene", "/nodeType") => Some(("tree_nodes", "id", "row")),
        ("tree_node" | "scene", "/title") => Some(("tree_nodes", "id", "row")),
        ("tree_node" | "scene", "/sortOrder") => Some(("tree_nodes", "id", "row")),
        ("tree_node" | "scene", "/synopsis") => Some(("tree_nodes", "id", "row")),
        ("scene", "/startTime") => Some(("tree_nodes", "chronicle_start_time", "text")),
        _ => None,
    };
    let Some((table, column, value_kind)) = legacy_field else {
        return Ok(false);
    };
    let predicate = match value_kind {
        "boolean" => format!("CAST({column} AS INTEGER) != 0"),
        "present" => format!("{column} IS NOT NULL"),
        "row" => format!("{column} IS NOT NULL"),
        _ => format!("NULLIF(TRIM(CAST({column} AS TEXT)), '') IS NOT NULL"),
    };
    let sql = format!(
        "SELECT EXISTS(
             SELECT 1 FROM {table} WHERE id = ?1 AND project_id = ?2
               AND {predicate}
         )",
    );
    Ok(conn.query_row(&sql, params![entity_id, project_id], |row| row.get(0))?)
}
