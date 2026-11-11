//! Native storage and transactional writers for the NIR-1 A1 scene scope.
//!
//! The existing tree and project scope authority still own membership and
//! order. These rows carry only the typed scope extension, incarnation,
//! principals, OCC version, and source token needed by readers.

use anyhow::{Context, Result};
use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(test)]
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

use grimodex_core::narrative_scene_scope::{
    self, NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
    NarrativeSceneScopeBindingV1, NarrativeSceneScopeRegistryV1,
    NarrativeScopeCompatibilityMarkerV1, NarrativeScopePrincipalV1,
    NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
};

use super::change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_snapshot_digest,
    AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind, NarrativeChangeEventInput,
    NarrativeChangeOrigin,
};
#[cfg(test)]
use super::nir1_capacity::project_read_probe;
use super::task_leases::with_immediate_transaction;
use crate::change_events::AppendChangeEvent;
use crate::idempotency::{
    canonical_write_payload_fingerprint, insert_idempotent_response, load_idempotent_response,
    IdempotencyRequest,
};
use crate::Database;

pub const SCENE_SCOPE_OBJECT_KIND: &str = "scene-scope";
pub const SCOPE_REGISTRY_OBJECT_KIND: &str = "scope-registry";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSceneScopeReadV1 {
    pub registry: NarrativeSceneScopeRegistryV1,
    /// Registry OCC/source metadata is returned with the scene read so the
    /// small registry editor can update the same Native-owned row without a
    /// second authority or an unguarded write.
    pub registry_revision: i64,
    pub registry_source_token: String,
    pub registry_updated_at: String,
    pub binding: NarrativeSceneScopeBindingV1,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSceneScopeUpdateV1 {
    pub schema_version: u32,
    pub compatibility_marker: NarrativeScopeCompatibilityMarkerV1,
    pub query_identity: NarrativeSceneQueryIdentityV1,
    pub material_constraint: NarrativeSceneMaterialConstraintV1,
    pub knowledge_holder: NarrativeScopePrincipalV1,
    pub audience: NarrativeScopePrincipalV1,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSceneScopeUpdatePayload {
    pub project_id: String,
    pub scene_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub base_version: i64,
    pub updated_at: String,
    pub scope: NarrativeSceneScopeUpdateV1,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSceneScopeRegistryUpdatePayload {
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub base_version: i64,
    pub updated_at: String,
    pub registry: NarrativeSceneScopeRegistryV1,
}

/// The main-line vocabulary (SDEF/1 R13). A registry created for the first
/// time carries these three references; vocabulary alone changes no
/// behaviour, because a new Scene is still `unknown` without a project default.
pub(crate) const MAIN_LINE_TIMELINE_REF: &str = "timeline:main";
pub(crate) const MAIN_LINE_WORLDLINE_REF: &str = "worldline:prime";
pub(crate) const MAIN_LINE_LAYER_REF: &str = "layer:manuscript";

/// The registry inserted when a project has no registry row yet (project
/// creation, the sample, a lazy repair, the A1 migration backfill). Existing
/// rows are never replaced (`ON CONFLICT DO NOTHING`).
fn initial_registry() -> NarrativeSceneScopeRegistryV1 {
    NarrativeSceneScopeRegistryV1 {
        registry_version: NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID.to_owned(),
        timeline_refs: vec![MAIN_LINE_TIMELINE_REF.to_owned()],
        worldline_refs: vec![MAIN_LINE_WORLDLINE_REF.to_owned()],
        narrative_layer_refs: vec![MAIN_LINE_LAYER_REF.to_owned()],
    }
}

/// How a binding creation treats the project Scope default (SDEF/1 MD2). The
/// inheriting value is produced only by [`scene_scope_init_for_create`]; every
/// other creation, repair, restore, sample, seed and fixture passes
/// `UnknownRepairOrRestore`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SceneScopeInit {
    NewSceneInheritProjectDefault,
    UnknownRepairOrRestore,
}

/// The origin, lineage, route and external source of one Scene creation, as
/// the creating writer has already validated them (SDEF/1 MD1).
#[derive(Clone, Copy, Debug)]
pub(crate) struct SceneCreateLineage<'a> {
    pub(crate) origin: NarrativeChangeOrigin,
    pub(crate) original_transaction_id: Option<&'a str>,
    pub(crate) undo_journal_id: Option<&'a str>,
    /// `None` when a Native caller writes without a renderer authority context.
    pub(crate) authority_route: Option<&'a str>,
    pub(crate) redo: bool,
    pub(crate) source_uri: Option<&'a str>,
    pub(crate) source_mtime: Option<&'a str>,
}

/// The one inheritance decision (SDEF/1 R7 (a)-(c), MD1). Only the three
/// creation writers (`tree_node_create_with_authority`, `apply_ai_tree_plan`,
/// `promote_sticky`) call it, after validating origin and lineage and inside
/// their transaction. (d) -- a `set` default whose references are members of
/// the same snapshot's registry -- is checked by the binding creation itself.
pub(crate) fn scene_scope_init_for_create(lineage: &SceneCreateLineage<'_>) -> SceneScopeInit {
    // (a) the author or an applied AI plan creates the Scene.
    let forward_origin = matches!(
        lineage.origin,
        NarrativeChangeOrigin::Human | NarrativeChangeOrigin::AiApply
    );
    // (b) no history replay of any kind.
    let not_replayed = lineage.original_transaction_id.is_none()
        && lineage.undo_journal_id.is_none()
        && !lineage.redo
        && !matches!(
            lineage.authority_route,
            Some("history-replay" | "restore-or-migration")
        );
    // (c) not a copy of an external file (an empty string still counts).
    let no_external_source = lineage.source_uri.is_none() && lineage.source_mtime.is_none();
    if forward_origin && not_replayed && no_external_source {
        SceneScopeInit::NewSceneInheritProjectDefault
    } else {
        SceneScopeInit::UnknownRepairOrRestore
    }
}

fn default_query_identity() -> NarrativeSceneQueryIdentityV1 {
    NarrativeSceneQueryIdentityV1 {
        timeline: unresolved_axis(),
        worldline: unresolved_axis(),
        narrative_layer: unresolved_axis(),
    }
}

fn unresolved_axis() -> narrative_scene_scope::NarrativeScopeConstraintV1 {
    narrative_scene_scope::NarrativeScopeConstraintV1::Unresolved {
        reason: "legacy-axis-unknown".to_owned(),
    }
}

fn default_material_constraint() -> NarrativeSceneMaterialConstraintV1 {
    NarrativeSceneMaterialConstraintV1 {
        timeline: narrative_scene_scope::NarrativeScopeConstraintV1::Any,
        worldline: narrative_scene_scope::NarrativeScopeConstraintV1::Any,
        narrative_layer: narrative_scene_scope::NarrativeScopeConstraintV1::Any,
    }
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    // Inside the Graph C-query's and the Graph registration's pinned
    // snapshots the schema cache answers without VM steps; every other caller
    // keeps the SQL check below.
    if let Some(present) = crate::nir1_pinned_snapshot::table_exists(conn, table)? {
        return Ok(present);
    }
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
        )",
        params![table],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

pub(super) fn read_registry_in_tx(
    conn: &Connection,
    project_id: &str,
) -> Result<NarrativeSceneScopeRegistryV1> {
    #[cfg(test)]
    project_read_probe::record(project_read_probe::Read::RegistryFull);
    let Some((registry_version, timeline, worldline, layer, version, source_token)) = conn
        .query_row(
            "SELECT registry_version, timeline_refs_json, worldline_refs_json,
                    narrative_layer_refs_json, version, source_token
               FROM narrative_scope_registries
              WHERE project_id = ?1",
            params![project_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?
    else {
        anyhow::bail!(
            "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scope registry row is missing for project '{project_id}'"
        );
    };
    let registry = NarrativeSceneScopeRegistryV1 {
        registry_version,
        timeline_refs: serde_json::from_str(&timeline)
            .context("scene scope registry timeline refs are invalid JSON")?,
        worldline_refs: serde_json::from_str(&worldline)
            .context("scene scope registry worldline refs are invalid JSON")?,
        narrative_layer_refs: serde_json::from_str(&layer)
            .context("scene scope registry layer refs are invalid JSON")?,
    };
    narrative_scene_scope::validate_registry(&registry)?;
    let expected_token = registry_source_token(&registry, version)?;
    anyhow::ensure!(
        source_token == expected_token,
        "NEX_SCENE_SCOPE_REGISTRY_SOURCE_TOKEN_INVALID: scope registry source token does not match its state"
    );
    Ok(registry)
}

fn scene_updated_at(conn: &Connection, project_id: &str, scene_id: &str) -> Result<String> {
    conn.query_row(
        "SELECT updated_at
           FROM tree_nodes
          WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
        params![scene_id, project_id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| anyhow::anyhow!("scene '{scene_id}' is not in project '{project_id}'"))
}

fn legacy_binding(
    project_id: &str,
    scene_id: &str,
    updated_at: String,
    registry: &NarrativeSceneScopeRegistryV1,
) -> Result<NarrativeSceneScopeBindingV1> {
    let mut binding = NarrativeSceneScopeBindingV1 {
        schema_version: 1,
        project_id: project_id.to_owned(),
        scene_id: scene_id.to_owned(),
        scene_incarnation_id: format!("legacy:{scene_id}"),
        compatibility_marker: NarrativeScopeCompatibilityMarkerV1::LegacyAbsent,
        query_identity: default_query_identity(),
        material_constraint: default_material_constraint(),
        knowledge_holder: NarrativeScopePrincipalV1::Reader {},
        audience: NarrativeScopePrincipalV1::Reader {},
        version: 1,
        source_token: "pending".to_owned(),
        updated_at,
    };
    binding.source_token = narrative_scene_scope::source_token(registry, &binding)?;
    Ok(binding)
}

fn parse_binding_row(
    project_id: &str,
    scene_id: &str,
    row: (String, String, String, String, String, i64, String, String),
) -> Result<NarrativeSceneScopeBindingV1> {
    let (
        incarnation,
        marker,
        query_identity,
        material_constraint,
        knowledge_holder,
        version,
        audience,
        source_token,
    ) = row;
    let binding = NarrativeSceneScopeBindingV1 {
        schema_version: 1,
        project_id: project_id.to_owned(),
        scene_id: scene_id.to_owned(),
        scene_incarnation_id: incarnation,
        compatibility_marker: serde_json::from_value(Value::String(marker))
            .context("scene scope compatibility marker is invalid")?,
        query_identity: serde_json::from_str(&query_identity)
            .context("scene scope query identity is invalid JSON")?,
        material_constraint: serde_json::from_str(&material_constraint)
            .context("scene scope material constraint is invalid JSON")?,
        knowledge_holder: serde_json::from_str(&knowledge_holder)
            .context("scene scope knowledge holder is invalid JSON")?,
        audience: serde_json::from_str(&audience)
            .context("scene scope audience is invalid JSON")?,
        version,
        source_token,
        updated_at: String::new(),
    };
    Ok(binding)
}

fn read_binding_in_tx(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    registry: &NarrativeSceneScopeRegistryV1,
) -> Result<NarrativeSceneScopeBindingV1> {
    // The table FK protects the scene id but not the `(project_id, scene_id)`
    // pairing.  Re-check the canonical tree owner before a binding can enter
    // an authority digest or a registry update, so a cross-project row cannot
    // influence either project's scope token.
    scene_updated_at(conn, project_id, scene_id)?;
    let Some(row) = conn
        .query_row(
            "SELECT scene_incarnation_id, compatibility_marker,
                    query_identity_json, material_constraint_json,
                    knowledge_holder_json, version, audience_json,
                    source_token, updated_at
               FROM narrative_scene_scope_bindings
              WHERE project_id = ?1 AND scene_id = ?2",
            params![project_id, scene_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()?
    else {
        anyhow::bail!(
            "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scope binding row is missing for scene '{scene_id}'"
        );
    };
    let (
        incarnation,
        marker,
        query_identity,
        material_constraint,
        knowledge_holder,
        version,
        audience,
        source_token,
        updated_at,
    ) = row;
    let mut binding = parse_binding_row(
        project_id,
        scene_id,
        (
            incarnation,
            marker,
            query_identity,
            material_constraint,
            knowledge_holder,
            version,
            audience,
            source_token,
        ),
    )?;
    binding.updated_at = updated_at;
    narrative_scene_scope::validate_binding(&binding, registry)?;
    let expected_token = narrative_scene_scope::source_token(registry, &binding)?;
    anyhow::ensure!(
        binding.source_token == expected_token,
        "NEX_SCENE_SCOPE_SOURCE_TOKEN_INVALID: scene scope source token does not match its state"
    );
    validate_principal_ownership(
        conn,
        project_id,
        &binding.knowledge_holder,
        "knowledgeHolder",
    )?;
    validate_principal_ownership(conn, project_id, &binding.audience, "audience")?;
    Ok(binding)
}

fn marker_text(marker: NarrativeScopeCompatibilityMarkerV1) -> &'static str {
    match marker {
        NarrativeScopeCompatibilityMarkerV1::LegacyAbsent => "legacy-absent",
        NarrativeScopeCompatibilityMarkerV1::Explicit => "explicit",
        NarrativeScopeCompatibilityMarkerV1::Unknown => "unknown",
    }
}

pub fn read_narrative_scene_scope(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> Result<NarrativeSceneScopeReadV1> {
    anyhow::ensure!(
        !project_id.trim().is_empty() && !scene_id.trim().is_empty(),
        "scene scope projectId and sceneId are required"
    );
    #[cfg(test)]
    project_read_probe::record(project_read_probe::Read::SceneScope);
    let storage_tables_present = table_exists(conn, "narrative_scope_registries")?
        && table_exists(conn, "narrative_scene_scope_bindings")?;
    if !storage_tables_present {
        anyhow::bail!(
            "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scene scope storage tables are missing"
        );
    }
    anyhow::ensure!(
        conn.query_row(
            "SELECT 1 FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![scene_id, project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some(),
        "scene '{scene_id}' is not in project '{project_id}'"
    );
    let registry = read_registry_in_tx(conn, project_id)?;
    let (registry_revision, registry_source_token, registry_updated_at) =
        read_registry_row(conn, project_id)?;
    let binding = read_binding_in_tx(conn, project_id, scene_id, &registry)?;
    validate_principal_ownership(
        conn,
        project_id,
        &binding.knowledge_holder,
        "knowledgeHolder",
    )?;
    validate_principal_ownership(conn, project_id, &binding.audience, "audience")?;
    Ok(NarrativeSceneScopeReadV1 {
        registry,
        registry_revision,
        registry_source_token,
        registry_updated_at,
        binding,
    })
}

pub(crate) fn canonical_scene_scope_snapshot(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> Result<Value> {
    serde_json::to_value(read_narrative_scene_scope(conn, project_id, scene_id)?)
        .map_err(Into::into)
}

pub(crate) fn canonical_scope_registry_snapshot(
    conn: &Connection,
    project_id: &str,
) -> Result<Value> {
    let registry = read_registry_in_tx(conn, project_id)?;
    let row: Option<(i64, String, String)> = conn
        .query_row(
            "SELECT version, source_token, updated_at
               FROM narrative_scope_registries
              WHERE project_id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (version, source_token, updated_at) = row.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scope registry row is missing for project '{project_id}'"
        )
    })?;
    Ok(json!({
        "projectId": project_id,
        "registry": registry,
        "version": version,
        "sourceToken": source_token,
        "updatedAt": updated_at,
    }))
}

pub(crate) fn ensure_scene_scope_binding_in_tx(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    updated_at: &str,
    init: SceneScopeInit,
) -> Result<()> {
    anyhow::ensure!(
        table_exists(conn, "narrative_scope_registries")?
            && table_exists(conn, "narrative_scene_scope_bindings")?,
        "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scene scope storage tables are missing"
    );
    ensure_scope_registry_in_tx(conn, project_id, updated_at)?;
    let registry = read_registry_in_tx(conn, project_id)?;
    let exists = conn
        .query_row(
            "SELECT 1 FROM narrative_scene_scope_bindings
              WHERE project_id = ?1 AND scene_id = ?2",
            params![project_id, scene_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    if exists {
        return Ok(());
    }
    let inherited = match init {
        SceneScopeInit::NewSceneInheritProjectDefault => {
            inherited_binding(conn, project_id, scene_id, updated_at, &registry)
        }
        SceneScopeInit::UnknownRepairOrRestore => None,
    };
    let binding = match inherited {
        Some(binding) => binding,
        None => {
            let mut binding = NarrativeSceneScopeBindingV1 {
                schema_version: 1,
                project_id: project_id.to_owned(),
                scene_id: scene_id.to_owned(),
                scene_incarnation_id: Uuid::new_v4().to_string(),
                compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Unknown,
                query_identity: default_query_identity(),
                material_constraint: default_material_constraint(),
                knowledge_holder: NarrativeScopePrincipalV1::Reader {},
                audience: NarrativeScopePrincipalV1::Reader {},
                version: 1,
                source_token: "pending".to_owned(),
                updated_at: updated_at.to_owned(),
            };
            binding.source_token = narrative_scene_scope::source_token(&registry, &binding)?;
            binding
        }
    };
    insert_binding_in_tx(conn, &binding)
}

/// The explicit binding a new Scene inherits from its project default, or
/// `None` (SDEF/1 R8, MD3). The default row is read on the same connection as
/// `registry`, so both come from the same transaction snapshot, and only the
/// row of this exact project is read. A missing, `none`, unreadable, corrupt or
/// dangling default -- any failure at all -- yields `None`, and the caller
/// writes `unknown`; the creation itself never fails because of the default.
fn inherited_binding(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    updated_at: &str,
    registry: &NarrativeSceneScopeRegistryV1,
) -> Option<NarrativeSceneScopeBindingV1> {
    let (query_identity, material_constraint) =
        super::scene_scope_default::inheritable_project_default_in_tx(conn, project_id)
            .ok()
            .flatten()?;
    let mut binding = NarrativeSceneScopeBindingV1 {
        schema_version: 1,
        project_id: project_id.to_owned(),
        scene_id: scene_id.to_owned(),
        scene_incarnation_id: Uuid::new_v4().to_string(),
        compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
        query_identity,
        material_constraint,
        knowledge_holder: NarrativeScopePrincipalV1::Reader {},
        audience: NarrativeScopePrincipalV1::Reader {},
        version: 1,
        source_token: "pending".to_owned(),
        updated_at: updated_at.to_owned(),
    };
    binding.source_token = narrative_scene_scope::source_token(registry, &binding).ok()?;
    narrative_scene_scope::validate_binding(&binding, registry).ok()?;
    Some(binding)
}

fn persisted_legacy_binding(
    project_id: &str,
    scene_id: &str,
    updated_at: String,
    registry: &NarrativeSceneScopeRegistryV1,
) -> Result<NarrativeSceneScopeBindingV1> {
    let mut binding = legacy_binding(project_id, scene_id, updated_at, registry)?;
    // This identifier is generated by Native once, during migration. It is
    // deliberately not derived from the scene id, title, or body so a later
    // id reuse cannot inherit the old scene incarnation.
    binding.scene_incarnation_id = Uuid::new_v4().to_string();
    binding.source_token = narrative_scene_scope::source_token(registry, &binding)?;
    Ok(binding)
}

pub(crate) fn ensure_scope_registry_in_tx(
    conn: &Connection,
    project_id: &str,
    updated_at: &str,
) -> Result<()> {
    if !table_exists(conn, "narrative_scope_registries")? {
        return Ok(());
    }
    let registry = initial_registry();
    let source_token = registry_source_token(&registry, 1)?;
    conn.execute(
        "INSERT INTO narrative_scope_registries (
            project_id, registry_version, timeline_refs_json, worldline_refs_json,
            narrative_layer_refs_json, version, source_token, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)
         ON CONFLICT(project_id) DO NOTHING",
        params![
            project_id,
            registry.registry_version,
            serde_json::to_string(&registry.timeline_refs)?,
            serde_json::to_string(&registry.worldline_refs)?,
            serde_json::to_string(&registry.narrative_layer_refs)?,
            source_token,
            updated_at,
        ],
    )?;
    Ok(())
}

/// Materialize the migration-time compatibility state for every existing
/// project and scene. Rows are inserted only when absent, so a retry cannot
/// replace a Native-owned incarnation or an already explicit binding.
pub(crate) fn backfill_scene_scope_storage_in_tx(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "narrative_scope_registries")?
        || !table_exists(conn, "narrative_scene_scope_bindings")?
    {
        return Ok(());
    }

    let projects = conn
        .prepare("SELECT id, updated_at FROM projects ORDER BY id")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (project_id, updated_at) in projects {
        ensure_scope_registry_in_tx(conn, &project_id, &updated_at)?;
    }

    let scenes = conn
        .prepare(
            "SELECT id, project_id, updated_at FROM tree_nodes
              WHERE node_type = 'scene' ORDER BY project_id, id",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (scene_id, project_id, updated_at) in scenes {
        let exists = conn
            .query_row(
                "SELECT 1 FROM narrative_scene_scope_bindings
                  WHERE project_id = ?1 AND scene_id = ?2",
                params![project_id, scene_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if exists {
            continue;
        }
        let registry = read_registry_in_tx(conn, &project_id)?;
        let binding = persisted_legacy_binding(&project_id, &scene_id, updated_at, &registry)?;
        insert_binding_in_tx(conn, &binding)?;
    }
    Ok(())
}

pub(crate) fn refresh_scene_scope_source_token_in_tx(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    updated_at: &str,
) -> Result<NarrativeChangeEventInput> {
    anyhow::ensure!(
        table_exists(conn, "narrative_scope_registries")?
            && table_exists(conn, "narrative_scene_scope_bindings")?,
        "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scene scope storage tables are missing"
    );
    let registry = read_registry_in_tx(conn, project_id)?;
    let before = canonical_scene_scope_snapshot(conn, project_id, scene_id)?;
    let mut binding = read_binding_in_tx(conn, project_id, scene_id, &registry)?;
    binding.version = binding
        .version
        .checked_add(1)
        .context("scene scope version overflow during source refresh")?;
    binding.updated_at = updated_at.to_owned();
    binding.source_token = narrative_scene_scope::source_token(&registry, &binding)?;
    let changed = conn.execute(
        "UPDATE narrative_scene_scope_bindings
            SET version = ?1, source_token = ?2, updated_at = ?3
          WHERE project_id = ?4 AND scene_id = ?5",
        params![
            binding.version,
            binding.source_token,
            binding.updated_at,
            project_id,
            scene_id
        ],
    )?;
    anyhow::ensure!(
        changed == 1,
        "scene scope binding disappeared during source refresh"
    );
    let after = canonical_scene_scope_snapshot(conn, project_id, scene_id)?;
    scene_scope_feed_event(
        scene_id,
        &before,
        &after,
        vec![
            "/binding/sourceToken".to_owned(),
            "/binding/updatedAt".to_owned(),
            "/binding/version".to_owned(),
        ],
    )
}

fn scene_scope_feed_event(
    scene_id: &str,
    before: &Value,
    after: &Value,
    changed_paths: Vec<String>,
) -> Result<NarrativeChangeEventInput> {
    let structural_impact = json!({
        "changedPaths": changed_paths.clone(),
        "scopeAuthorityChanged": true,
    });
    Ok(NarrativeChangeEventInput {
        object_key: json!({
            "kind": SCENE_SCOPE_OBJECT_KIND,
            "sceneId": scene_id,
        }),
        change_kind: "metadata".to_owned(),
        mutation_kind: "update".to_owned(),
        before_version: before["binding"]["version"].as_i64(),
        before_digest: Some(narrative_snapshot_digest(before)?),
        after_version: after["binding"]["version"].as_i64(),
        after_digest: Some(narrative_snapshot_digest(after)?),
        changed_paths,
        text_impact: None,
        structural_impact: Some(structural_impact),
    })
}

/// Refresh a scene's scope token when the caller has only the scene identity.
/// Restore/undo helpers intentionally receive the same narrow identity as the
/// existing tree writer, so resolve the trusted project owner from `tree_nodes`
/// instead of accepting a renderer-supplied project binding.
pub(crate) fn refresh_scene_scope_source_token_for_scene_in_tx(
    conn: &Connection,
    scene_id: &str,
    updated_at: &str,
) -> Result<NarrativeChangeEventInput> {
    let project_id: String = conn.query_row(
        "SELECT project_id FROM tree_nodes WHERE id = ?1 AND node_type = 'scene'",
        params![scene_id],
        |row| row.get(0),
    )?;
    refresh_scene_scope_source_token_in_tx(conn, &project_id, scene_id, updated_at)
}

/// Advance the Scope generation (binding version, source token, updatedAt) of
/// every Scene in `scene_ids` and return one feed event per Scene, in
/// ascending Scene id order.
///
/// A folder's `parentId`, `sortOrder` and `archivedAt` decide where every live
/// Scene below it sits in the project's Reading order, but the project Scope
/// authority no longer observes the tree's own version/updatedAt. The writers
/// that change such a folder call this in the same transaction with the live
/// Scenes below it from before and after the change, so the project token
/// cannot return to an earlier value after the live structure moved.
pub(crate) fn refresh_scene_scope_source_tokens_in_tx(
    conn: &Connection,
    project_id: &str,
    scene_ids: &BTreeSet<String>,
    updated_at: &str,
) -> Result<Vec<NarrativeChangeEventInput>> {
    scene_ids
        .iter()
        .map(|scene_id| {
            refresh_scene_scope_source_token_in_tx(conn, project_id, scene_id, updated_at)
        })
        .collect()
}

fn insert_binding_in_tx(conn: &Connection, binding: &NarrativeSceneScopeBindingV1) -> Result<()> {
    conn.execute(
        "INSERT INTO narrative_scene_scope_bindings (
            project_id, scene_id, scene_incarnation_id, compatibility_marker,
            query_identity_json, material_constraint_json, knowledge_holder_json,
            audience_json, version, source_token, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            binding.project_id,
            binding.scene_id,
            binding.scene_incarnation_id,
            marker_text(binding.compatibility_marker),
            serde_json::to_string(&binding.query_identity)?,
            serde_json::to_string(&binding.material_constraint)?,
            serde_json::to_string(&binding.knowledge_holder)?,
            serde_json::to_string(&binding.audience)?,
            binding.version,
            binding.source_token,
            binding.updated_at,
        ],
    )?;
    Ok(())
}

/// The Scene-scope part of a project's Scope authority: its digest, which is
/// part of the authority's revision token, and, when asked for, the binding of
/// every Scene as a single-Scene read ([`read_narrative_scene_scope`]) returns
/// it. The digest read already parses and validates every binding row against
/// the registry, the tree and the principals; keeping the valid ones lets a
/// caller that needs several Scenes' bindings in one snapshot read them once.
///
/// The digest covers the Native-owned Scope observations that extend the
/// project's base Scope authority: the registry (revision, source token) and
/// every Scene binding (version, source token, updatedAt included).
/// `tree_nodes.version`/`updated_at` are deliberately not part of it. ADR009
/// keeps titles, bodies and display labels, and operations on empty folders
/// and notes, out of this Source, so the Source must not move for them.
#[derive(Debug)]
pub(crate) struct ScopeExtension {
    pub(crate) digest: String,
    /// Empty unless the read was asked to collect them. A Scene whose row is
    /// missing or fails any check a single-Scene read makes is absent.
    pub(crate) scene_bindings: BTreeMap<String, NarrativeSceneScopeBindingV1>,
}

/// The ids of the project's Scene nodes (every `tree_nodes` row of the
/// project whose `node_type` is `scene`, archived ones included), the set a
/// binding's Scene must belong to (DR-CQA-6). Built from the rows the Scope
/// authority has already read, so the extension does not read `tree_nodes`
/// again to decide `sceneOwned`.
///
/// The ids are copied into one buffer, so the set is two allocations
/// whatever the number of Scenes. Keeping one small allocation per Scene
/// alive while the rest of the tree is freed scattered them through the
/// worker's fixed Q heap and slowed every later allocation of the query
/// (about +7 ms at 352 Scenes and 4 Revisions; DR-CQA-6).
pub(crate) struct ProjectSceneIds {
    buf: String,
    spans: Vec<(usize, usize)>,
}

impl ProjectSceneIds {
    /// Sorted here, whatever order the caller read the nodes in: membership
    /// does not depend on the SQL `ORDER BY` of the read it came from.
    pub(crate) fn from_unsorted<'a>(ids: impl IntoIterator<Item = &'a str>) -> Self {
        let mut ids: Vec<&str> = ids.into_iter().collect();
        ids.sort_unstable();
        ids.dedup();
        let mut buf = String::with_capacity(ids.iter().map(|id| id.len()).sum());
        let mut spans = Vec::with_capacity(ids.len());
        for id in ids {
            let start = buf.len();
            buf.push_str(id);
            spans.push((start, buf.len()));
        }
        Self { buf, spans }
    }

    fn id(&self, &(start, end): &(usize, usize)) -> &str {
        &self.buf[start..end]
    }

    fn contains(&self, id: &str) -> bool {
        self.spans
            .binary_search_by(|span| self.id(span).cmp(id))
            .is_ok()
    }

    #[cfg(test)]
    pub(crate) fn ids(&self) -> Vec<&str> {
        self.spans.iter().map(|span| self.id(span)).collect()
    }
}

/// How the eleventh column of the extension's raw row, `sceneOwned`, is
/// decided: from the project's Scene ids, or (tests only) by the join of
/// `tree_nodes` that decided it before DR-CQA-6, kept as the oracle the set is
/// checked against.
#[derive(Clone, Copy)]
pub(crate) enum SceneOwnership<'a> {
    Set(&'a ProjectSceneIds),
    #[cfg(test)]
    LegacyJoin,
}

pub(crate) fn read_scope_extension(
    conn: &Connection,
    project_id: &str,
    collect_scene_bindings: bool,
    ownership: SceneOwnership<'_>,
) -> Result<ScopeExtension> {
    // Each binding's observation goes straight into the digest as it is
    // produced; no `Vec<Value>` of every binding (and no second copy of it)
    // is held (DR-GRW-5).
    let mut digest_stream = begin_scope_extension_digest()?;
    let parts = read_scope_extension_entries(
        conn,
        project_id,
        collect_scene_bindings,
        ownership,
        |entry: Value| Ok(digest_stream.value(&entry)?),
    )?;
    let digest = finish_scope_extension_digest(
        digest_stream,
        &parts.registry,
        parts.registry_revision,
        &parts.registry_source_token,
    )?;
    Ok(ScopeExtension {
        digest,
        scene_bindings: parts.scene_bindings,
    })
}

/// What [`read_scope_extension_entries`] returns besides the per-binding
/// entries it hands to its sink.
struct ScopeExtensionParts {
    registry: NarrativeSceneScopeRegistryV1,
    registry_revision: i64,
    registry_source_token: String,
    scene_bindings: BTreeMap<String, NarrativeSceneScopeBindingV1>,
}

/// The extension's one read of the Scene bindings (DR-CQA-6): the binding row
/// and the Codex rows its two principals name. It does not join `tree_nodes`;
/// the Scene a binding belongs to is decided from [`ProjectSceneIds`] and
/// returned to the caller as the eleventh raw column.
/// The two `LEFT JOIN codex_entries` that read a binding's principals: the
/// holder and the audience, each a Codex row of the project's characters that
/// the principal's `$.ref` names. The extension's read and the charge that
/// counts the rows it makes ([`SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL`], DR-CQA-7)
/// are built from this one text, so they cannot name different rows.
macro_rules! scope_extension_principal_joins {
    () => {
        "           LEFT JOIN codex_entries kh
             ON kh.project_id = b.project_id
            AND kh.type = 'character'
            AND kh.id = CASE WHEN json_valid(b.knowledge_holder_json)
                             THEN json_extract(b.knowledge_holder_json, '$.ref')
                             ELSE NULL END
           LEFT JOIN codex_entries au
             ON au.project_id = b.project_id
            AND au.type = 'character'
            AND au.id = CASE WHEN json_valid(b.audience_json)
                             THEN json_extract(b.audience_json, '$.ref')
                             ELSE NULL END
"
    };
}

pub(crate) const SCOPE_EXTENSION_SQL: &str = concat!(
    "SELECT b.scene_id, b.scene_incarnation_id, b.compatibility_marker,
                b.query_identity_json, b.material_constraint_json,
                b.knowledge_holder_json, b.version, b.audience_json,
                b.source_token, b.updated_at,
                CASE WHEN kh.id IS NOT NULL THEN 1 ELSE 0 END,
                CASE WHEN au.id IS NOT NULL THEN 1 ELSE 0 END
           FROM narrative_scene_scope_bindings b
",
    scope_extension_principal_joins!(),
    "          WHERE b.project_id = ?1
          ORDER BY b.scene_id"
);

/// The number of Codex rows [`SCOPE_EXTENSION_SQL`] reads through its two
/// `LEFT JOIN codex_entries` for one project (`?1`): a holder that names a
/// character of the project counts one, an audience that does counts one more,
/// so one character named by both counts twice (DR-CQA-7). The statement is
/// the extension's own FROM clause (the same binding rows, the same joins,
/// from [`scope_extension_principal_joins`]) with the two joined ids counted
/// instead of returned. It is what the query's shared-read charge adds for the
/// principals.
pub(crate) const SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL: &str = concat!(
    "SELECT COUNT(kh.id) + COUNT(au.id)
           FROM narrative_scene_scope_bindings b
",
    scope_extension_principal_joins!(),
    "          WHERE b.project_id = ?1"
);

/// The statement before DR-CQA-6, verbatim: `sceneOwned` from a `LEFT JOIN
/// tree_nodes`. Tests only; the oracle [`SCOPE_EXTENSION_SQL`] and the Scene-id
/// set are checked against.
#[cfg(test)]
const SCOPE_EXTENSION_LEGACY_JOIN_SQL: &str =
    "SELECT b.scene_id, b.scene_incarnation_id, b.compatibility_marker,
                b.query_identity_json, b.material_constraint_json,
                b.knowledge_holder_json, b.version, b.audience_json,
                b.source_token, b.updated_at,
                CASE WHEN s.id IS NOT NULL AND s.project_id = b.project_id
                           AND s.node_type = 'scene' THEN 1 ELSE 0 END,
                CASE WHEN kh.id IS NOT NULL THEN 1 ELSE 0 END,
                CASE WHEN au.id IS NOT NULL THEN 1 ELSE 0 END
           FROM narrative_scene_scope_bindings b
           LEFT JOIN tree_nodes s
             ON s.id = b.scene_id AND s.project_id = b.project_id
           LEFT JOIN codex_entries kh
             ON kh.project_id = b.project_id
            AND kh.type = 'character'
            AND kh.id = CASE WHEN json_valid(b.knowledge_holder_json)
                             THEN json_extract(b.knowledge_holder_json, '$.ref')
                             ELSE NULL END
           LEFT JOIN codex_entries au
             ON au.project_id = b.project_id
            AND au.type = 'character'
            AND au.id = CASE WHEN json_valid(b.audience_json)
                             THEN json_extract(b.audience_json, '$.ref')
                             ELSE NULL END
          WHERE b.project_id = ?1
          ORDER BY b.scene_id";

/// Read and validate every Scene binding row of the project in `ORDER BY
/// b.scene_id` order and hand one digest entry per row to `on_entry`: the
/// binding itself, or an `unavailable` observation of the raw row.
fn read_scope_extension_entries(
    conn: &Connection,
    project_id: &str,
    collect_scene_bindings: bool,
    ownership: SceneOwnership<'_>,
    mut on_entry: impl FnMut(Value) -> Result<()>,
) -> Result<ScopeExtensionParts> {
    anyhow::ensure!(
        table_exists(conn, "narrative_scope_registries")?
            && table_exists(conn, "narrative_scene_scope_bindings")?,
        "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scene scope storage tables are missing"
    );
    #[cfg(test)]
    project_read_probe::record(project_read_probe::Read::ScopeExtension);
    let registry = read_registry_in_tx(conn, project_id)?;
    let (registry_revision, registry_source_token, _) = read_registry_row(conn, project_id)?;
    let mut scene_bindings = BTreeMap::new();
    let (sql, scene_ids) = match ownership {
        SceneOwnership::Set(ids) => (SCOPE_EXTENSION_SQL, Some(ids)),
        #[cfg(test)]
        SceneOwnership::LegacyJoin => (SCOPE_EXTENSION_LEGACY_JOIN_SQL, None),
    };
    let mut statement = conn.prepare(sql)?;
    let rows = statement
        .query_map(params![project_id], |row| {
            let mut values = Vec::with_capacity(13);
            match scene_ids {
                // The statement does not read `tree_nodes`: it returns the 12
                // other columns, and `sceneOwned` goes in as the eleventh
                // with the same value (a 0/1 integer) the join gave it.
                Some(scene_ids) => {
                    for index in 0..10 {
                        values.push(row.get::<_, SqlValue>(index)?);
                    }
                    let scene_owned = match &values[0] {
                        SqlValue::Text(scene_id) => scene_ids.contains(scene_id),
                        _ => false,
                    };
                    values.push(SqlValue::Integer(i64::from(scene_owned)));
                    values.push(row.get::<_, SqlValue>(10)?);
                    values.push(row.get::<_, SqlValue>(11)?);
                }
                None => {
                    for index in 0..13 {
                        values.push(row.get::<_, SqlValue>(index)?);
                    }
                }
            }
            Ok(values)
        })?
        .collect::<rusqlite::Result<Vec<Vec<_>>>>()?;
    for raw_values in rows {
        let scene_id_hint = raw_values
            .first()
            .and_then(|value| match value {
                SqlValue::Text(value) => Some(value.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "<invalid-scene-id>".to_owned());
        let raw = scene_scope_digest_raw_row(&raw_values);
        let binding = (|| -> Result<Option<NarrativeSceneScopeBindingV1>> {
            let [scene_id, incarnation, marker, query_identity, material_constraint, knowledge_holder, version, audience, source_token, updated_at, scene_owned, knowledge_holder_owned, audience_owned] =
                raw_values
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("scene scope row has an invalid column count"))?;
            let scene_id = material_scope_text(scene_id)?;
            let incarnation = material_scope_text(incarnation)?;
            let marker = material_scope_text(marker)?;
            let query_identity = material_scope_text(query_identity)?;
            let material_constraint = material_scope_text(material_constraint)?;
            let knowledge_holder = material_scope_text(knowledge_holder)?;
            let version = material_scope_integer(version)?;
            let audience = material_scope_text(audience)?;
            let source_token = material_scope_text(source_token)?;
            let updated_at = material_scope_text(updated_at)?;
            let scene_owned = material_scope_integer(scene_owned)?;
            let knowledge_holder_owned = material_scope_integer(knowledge_holder_owned)?;
            let audience_owned = material_scope_integer(audience_owned)?;
            anyhow::ensure!(
                scene_owned == 1,
                "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scope binding scene '{scene_id}' is missing or belongs to another project"
            );
            let mut binding = parse_binding_row(
                project_id,
                &scene_id,
                (
                    incarnation,
                    marker,
                    query_identity,
                    material_constraint,
                    knowledge_holder,
                    version,
                    audience,
                    source_token,
                ),
            )?;
            binding.updated_at = updated_at;
            narrative_scene_scope::validate_binding(&binding, &registry)?;
            if matches!(
                binding.knowledge_holder,
                NarrativeScopePrincipalV1::Character { .. }
            ) {
                anyhow::ensure!(
                    knowledge_holder_owned == 1,
                    "knowledgeHolder character is not in project '{project_id}'"
                );
            }
            if matches!(
                binding.audience,
                NarrativeScopePrincipalV1::Character { .. }
            ) {
                anyhow::ensure!(
                    audience_owned == 1,
                    "audience character is not in project '{project_id}'"
                );
            }
            let expected_token = narrative_scene_scope::source_token(&registry, &binding)?;
            anyhow::ensure!(
                binding.source_token == expected_token,
                "NEX_SCENE_SCOPE_SOURCE_TOKEN_INVALID: scene scope source token does not match its state"
            );
            Ok(Some(binding))
        })();
        match binding {
            Ok(Some(binding)) => {
                if collect_scene_bindings {
                    scene_bindings.insert(binding.scene_id.clone(), binding.clone());
                }
                on_entry(serde_json::to_value(binding)?)?;
            }
            Ok(None) => {}
            Err(_) => on_entry(json!({
                "sceneId": scene_id_hint,
                "status": "unavailable",
                "rawDigest": grimodex_core::canonical_json_digest(&raw)?,
            }))?,
        }
    }
    Ok(ScopeExtensionParts {
        registry,
        registry_revision,
        registry_source_token,
        scene_bindings,
    })
}

/// Open the extension digest's document: the `bindings` array, which is the
/// first key in canonical (UTF-16) order. Every binding observation is then
/// written with [`CanonicalJsonStream::value`] in `ORDER BY b.scene_id` order.
fn begin_scope_extension_digest(
) -> Result<grimodex_core::CanonicalJsonStream<grimodex_core::CanonicalDigestSink>> {
    let mut stream = grimodex_core::CanonicalJsonStream::digest();
    stream.begin_object()?;
    stream.key("bindings")?;
    stream.begin_array()?;
    Ok(stream)
}

/// Close the document opened by [`begin_scope_extension_digest`] with the
/// remaining keys in canonical order (`bindings < contractId < registry <
/// registryRevision < registrySourceToken`; the stream checks the order). The
/// digest equals `canonical_json_digest` of the same document built as one
/// `serde_json::Value`.
///
/// Native-owned monotonic/source observations remain in the authority digest
/// even for compatibility-only bindings: the registry revision and source
/// token, and every binding's version, source token and updatedAt. They keep an
/// A->B->A or same-timestamp write from recreating an old token.
///
/// The tree's own `version`/`updated_at` are NOT observed here. A writer that
/// changes where live Scenes sit therefore has to advance the affected Scenes'
/// binding generation in the same transaction: a Scene patch refreshes its own
/// binding, and a folder's parentId/sortOrder/archivedAt change refreshes every
/// live Scene below it (`refresh_scene_scope_source_tokens_in_tx`). Empty
/// folders and notes carry no Scene, so they never move this digest.
fn finish_scope_extension_digest(
    mut stream: grimodex_core::CanonicalJsonStream<grimodex_core::CanonicalDigestSink>,
    registry: &NarrativeSceneScopeRegistryV1,
    registry_revision: i64,
    registry_source_token: &str,
) -> Result<String> {
    stream.end_array()?;
    stream.key("contractId")?;
    stream.string(narrative_scene_scope::NARRATIVE_SCENE_SCOPE_CONTRACT_ID)?;
    stream.key("registry")?;
    stream.value(&serde_json::to_value(registry)?)?;
    stream.key("registryRevision")?;
    stream.value(&Value::from(registry_revision))?;
    stream.key("registrySourceToken")?;
    stream.string(registry_source_token)?;
    stream.end_object()?;
    Ok(stream.finish_digest()?)
}

fn scene_scope_digest_raw_value(value: &SqlValue) -> Value {
    match value {
        SqlValue::Null => json!({"type": "null"}),
        SqlValue::Integer(value) => json!({"type": "integer", "value": value}),
        SqlValue::Real(value) => json!({
            "type": "real",
            "bits": format!("{:016x}", value.to_bits()),
        }),
        SqlValue::Text(value) => json!({"type": "text", "value": value}),
        SqlValue::Blob(value) => json!({
            "type": "blob",
            "hex": hex::encode(value),
        }),
    }
}

fn scene_scope_digest_raw_row(values: &[SqlValue]) -> Value {
    const COLUMN_NAMES: [&str; 13] = [
        "sceneId",
        "sceneIncarnationId",
        "compatibilityMarker",
        "queryIdentity",
        "materialConstraint",
        "knowledgeHolder",
        "version",
        "audience",
        "sourceToken",
        "updatedAt",
        "sceneOwned",
        "knowledgeHolderOwned",
        "audienceOwned",
    ];
    let mut raw = serde_json::Map::new();
    for (index, name) in COLUMN_NAMES.iter().enumerate() {
        raw.insert(
            (*name).to_owned(),
            values
                .get(index)
                .map(scene_scope_digest_raw_value)
                .unwrap_or_else(|| json!({"type": "missing"})),
        );
    }
    Value::Object(raw)
}

fn registry_source_token(registry: &NarrativeSceneScopeRegistryV1, version: i64) -> Result<String> {
    Ok(grimodex_core::canonical_json_digest(&json!({
        "contractId": narrative_scene_scope::NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
        "registry": registry,
        "version": version,
    }))?)
}

fn validate_principal_ownership(
    conn: &Connection,
    project_id: &str,
    principal: &NarrativeScopePrincipalV1,
    field: &str,
) -> Result<()> {
    if let NarrativeScopePrincipalV1::Character { reference } = principal {
        anyhow::ensure!(
            conn.query_row(
                "SELECT 1 FROM codex_entries
                  WHERE id = ?1 AND project_id = ?2 AND type = 'character'",
                params![reference, project_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some(),
            "{field} character '{reference}' is not in project '{project_id}'"
        );
    }
    Ok(())
}

/// Character identities are Native-owned references. A delete or type change
/// must not leave an explicit scene binding pointing at an identity that can
/// later be reused. Callers hold the surrounding write transaction.
pub(crate) fn ensure_character_reference_mutation_allowed_in_tx(
    conn: &Connection,
    project_id: &str,
    character_id: &str,
    operation: &str,
) -> Result<()> {
    anyhow::ensure!(
        table_exists(conn, "narrative_scope_registries")?
            && table_exists(conn, "narrative_scene_scope_bindings")?,
        "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scene scope storage tables are missing"
    );
    let referenced_scene = conn
        .query_row(
            "SELECT scene_id
               FROM narrative_scene_scope_bindings
              WHERE project_id = ?1
                AND (
                    (CASE WHEN json_valid(knowledge_holder_json)
                          THEN json_extract(knowledge_holder_json, '$.kind')
                          ELSE NULL END = 'character'
                     AND CASE WHEN json_valid(knowledge_holder_json)
                              THEN json_extract(knowledge_holder_json, '$.ref')
                              ELSE NULL END = ?2)
                 OR (CASE WHEN json_valid(audience_json)
                          THEN json_extract(audience_json, '$.kind')
                          ELSE NULL END = 'character'
                     AND CASE WHEN json_valid(audience_json)
                              THEN json_extract(audience_json, '$.ref')
                              ELSE NULL END = ?2)
                )
              ORDER BY scene_id
              LIMIT 1",
            params![project_id, character_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(scene_id) = referenced_scene {
        anyhow::bail!(
            "NEX_SCENE_SCOPE_CHARACTER_REFERENCED: cannot {operation} character '{character_id}' while scene '{scene_id}' references it"
        );
    }
    Ok(())
}

/// Scenes of `project_id` whose `pov_character_id` names `entry_id`, whether
/// or not they are live. Deleting the Codex entry clears the column through
/// `ON DELETE SET NULL`, which changes the Scene's POV (a Scope field) without
/// touching the binding, so the caller lists the Scenes before the delete and
/// advances their Scope generation in the same transaction afterwards.
pub(crate) fn scene_ids_with_pov_character_in_tx(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
) -> Result<BTreeSet<String>> {
    let mut statement = conn.prepare(
        "SELECT id FROM tree_nodes
          WHERE project_id = ?1 AND node_type = 'scene' AND pov_character_id = ?2
          ORDER BY id",
    )?;
    let scene_ids = statement
        .query_map(params![project_id, entry_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    Ok(scene_ids)
}

/// A Codex-only snapshot restore replaces the complete Codex projection. A
/// binding that currently points at a character must not silently survive a
/// snapshot that deletes that character or changes its type. The caller
/// supplies Native's already-derived target rows, so this check runs before
/// the restore mutates any table and does not infer authority from the
/// renderer payload.
pub(crate) fn ensure_character_snapshot_restore_allowed_in_tx(
    conn: &Connection,
    project_id: &str,
    target_entry_types: &[(String, String)],
) -> Result<()> {
    anyhow::ensure!(
        table_exists(conn, "narrative_scope_registries")?
            && table_exists(conn, "narrative_scene_scope_bindings")?,
        "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scene scope storage tables are missing"
    );
    let target_types = target_entry_types
        .iter()
        .map(|(entry_id, entry_type)| (entry_id.as_str(), entry_type.as_str()))
        .collect::<std::collections::BTreeMap<_, _>>();
    let referenced_principals = conn
        .prepare(
            "SELECT refs.reference, COUNT(entry.id), MIN(entry.type), MAX(entry.type)
               FROM (
                    SELECT DISTINCT reference
                      FROM (
                           SELECT CASE WHEN json_valid(knowledge_holder_json)
                                       THEN json_extract(knowledge_holder_json, '$.ref')
                                       ELSE NULL END AS reference
                             FROM narrative_scene_scope_bindings
                            WHERE project_id = ?1
                              AND CASE WHEN json_valid(knowledge_holder_json)
                                       THEN json_extract(knowledge_holder_json, '$.kind')
                                       ELSE NULL END = 'character'
                           UNION ALL
                           SELECT CASE WHEN json_valid(audience_json)
                                       THEN json_extract(audience_json, '$.ref')
                                       ELSE NULL END AS reference
                             FROM narrative_scene_scope_bindings
                            WHERE project_id = ?1
                              AND CASE WHEN json_valid(audience_json)
                                       THEN json_extract(audience_json, '$.kind')
                                       ELSE NULL END = 'character'
                      )
                     WHERE reference IS NOT NULL
               ) refs
               LEFT JOIN codex_entries entry
                 ON entry.id = refs.reference AND entry.project_id = ?1
              GROUP BY refs.reference
              ORDER BY refs.reference",
        )?
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (character_id, current_count, min_type, max_type) in referenced_principals {
        anyhow::ensure!(
            current_count == 1
                && min_type.as_deref() == Some("character")
                && max_type.as_deref() == Some("character"),
            "NEX_SCENE_SCOPE_CHARACTER_REFERENCED: referenced character '{}' is missing or is not exactly one same-project character",
            character_id
        );
        anyhow::ensure!(
            target_types.get(character_id.as_str()).copied() == Some("character"),
            "NEX_SCENE_SCOPE_CHARACTER_REFERENCED: Codex snapshot would delete or change the type of referenced character '{}'",
            character_id
        );
    }
    Ok(())
}

/// Invalidate every binding that names a restored character and return the
/// same-transaction Feed events describing those authority changes.
pub(crate) fn invalidate_character_references_with_events_in_tx(
    conn: &Connection,
    project_id: &str,
    character_id: &str,
    updated_at: &str,
) -> Result<Vec<NarrativeChangeEventInput>> {
    anyhow::ensure!(
        table_exists(conn, "narrative_scope_registries")?
            && table_exists(conn, "narrative_scene_scope_bindings")?,
        "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scene scope storage tables are missing"
    );
    let registry = read_registry_in_tx(conn, project_id)?;
    let scene_ids = {
        let mut statement = conn.prepare(
            "SELECT scene_id
               FROM narrative_scene_scope_bindings
              WHERE project_id = ?1
                AND (
                    (CASE WHEN json_valid(knowledge_holder_json)
                          THEN json_extract(knowledge_holder_json, '$.kind')
                          ELSE NULL END = 'character'
                     AND CASE WHEN json_valid(knowledge_holder_json)
                              THEN json_extract(knowledge_holder_json, '$.ref')
                              ELSE NULL END = ?2)
                 OR (CASE WHEN json_valid(audience_json)
                          THEN json_extract(audience_json, '$.kind')
                          ELSE NULL END = 'character'
                     AND CASE WHEN json_valid(audience_json)
                              THEN json_extract(audience_json, '$.ref')
                              ELSE NULL END = ?2)
                )
              ORDER BY scene_id",
        )?;
        let scene_ids = statement
            .query_map(params![project_id, character_id], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        scene_ids
    };
    let mut events = Vec::new();
    for scene_id in scene_ids {
        let before = canonical_scene_scope_snapshot(conn, project_id, &scene_id)?;
        let mut binding = read_binding_in_tx(conn, project_id, &scene_id, &registry)?;
        binding.compatibility_marker = NarrativeScopeCompatibilityMarkerV1::Unknown;
        binding.query_identity = default_query_identity();
        binding.material_constraint = default_material_constraint();
        binding.knowledge_holder = NarrativeScopePrincipalV1::Reader {};
        binding.audience = NarrativeScopePrincipalV1::Reader {};
        binding.version = binding
            .version
            .checked_add(1)
            .context("scene scope version overflow during character invalidation")?;
        binding.updated_at = updated_at.to_owned();
        binding.source_token = narrative_scene_scope::source_token(&registry, &binding)?;
        let changed = conn.execute(
            "UPDATE narrative_scene_scope_bindings
                SET compatibility_marker = ?1,
                    query_identity_json = ?2,
                    material_constraint_json = ?3,
                    knowledge_holder_json = ?4,
                    audience_json = ?5,
                    version = ?6,
                    source_token = ?7,
                    updated_at = ?8
              WHERE project_id = ?9 AND scene_id = ?10",
            params![
                marker_text(binding.compatibility_marker),
                serde_json::to_string(&binding.query_identity)?,
                serde_json::to_string(&binding.material_constraint)?,
                serde_json::to_string(&binding.knowledge_holder)?,
                serde_json::to_string(&binding.audience)?,
                binding.version,
                binding.source_token,
                binding.updated_at,
                project_id,
                scene_id,
            ],
        )?;
        anyhow::ensure!(
            changed == 1,
            "scene scope binding disappeared during invalidation"
        );
        let after = canonical_scene_scope_snapshot(conn, project_id, &scene_id)?;
        events.push(scene_scope_feed_event(
            &scene_id,
            &before,
            &after,
            vec![
                "/binding/compatibilityMarker".to_owned(),
                "/binding/queryIdentity".to_owned(),
                "/binding/materialConstraint".to_owned(),
                "/binding/knowledgeHolder".to_owned(),
                "/binding/audience".to_owned(),
                "/binding/version".to_owned(),
                "/binding/sourceToken".to_owned(),
                "/binding/updatedAt".to_owned(),
            ],
        )?);
    }
    Ok(events)
}

fn event_timestamp(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.timestamp_millis())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis())
}

fn require_write_identity(payload_project: &str, values: &[(&str, &str)]) -> Result<()> {
    anyhow::ensure!(
        !payload_project.trim().is_empty(),
        "scene scope projectId is required"
    );
    for (field, value) in values {
        anyhow::ensure!(!value.trim().is_empty(), "scene scope {field} is required");
    }
    Ok(())
}

pub fn update_narrative_scene_scope(
    db: &Database,
    payload: NarrativeSceneScopeUpdatePayload,
) -> Result<Value> {
    require_write_identity(
        &payload.project_id,
        &[
            ("sceneId", &payload.scene_id),
            ("requestId", &payload.request_id),
            ("sessionId", &payload.session_id),
            ("eventUid", &payload.event_uid),
            ("updatedAt", &payload.updated_at),
        ],
    )?;
    anyhow::ensure!(
        payload.base_version >= 1,
        "scene scope baseVersion must be positive"
    );
    anyhow::ensure!(
        payload.scope.schema_version == 1,
        "unsupported scene scope schemaVersion"
    );
    let request_hash =
        canonical_write_payload_fingerprint("narrative_scene_scope_update", &payload)?;
    let idempotency = IdempotencyRequest {
        domain: "narrative_scene_scope_update",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "NEX_SCENE_SCOPE_REQUEST_CONFLICT",
    };
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |tx| {
            if let Some(response) = load_idempotent_response(tx, &idempotency)? {
                return Ok(response);
            }
            let current = read_narrative_scene_scope(tx, &payload.project_id, &payload.scene_id)?;
            anyhow::ensure!(
                current.binding.version == payload.base_version,
                "NEX_SCENE_SCOPE_VERSION_MISMATCH: expected base version {}, current is {}",
                payload.base_version,
                current.binding.version
            );
            anyhow::ensure!(
                payload.scope.compatibility_marker
                    != NarrativeScopeCompatibilityMarkerV1::LegacyAbsent
                    || current.binding.compatibility_marker
                        == NarrativeScopeCompatibilityMarkerV1::LegacyAbsent,
                "NEX_SCENE_SCOPE_LEGACY_MARKER_RESTORE: explicit or unknown scope cannot return to legacy-absent"
            );
            validate_principal_ownership(
                tx,
                &payload.project_id,
                &payload.scope.knowledge_holder,
                "knowledgeHolder",
            )?;
            validate_principal_ownership(
                tx,
                &payload.project_id,
                &payload.scope.audience,
                "audience",
            )?;
            let mut next = NarrativeSceneScopeBindingV1 {
                schema_version: payload.scope.schema_version,
                project_id: payload.project_id.clone(),
                scene_id: payload.scene_id.clone(),
                scene_incarnation_id: current.binding.scene_incarnation_id.clone(),
                compatibility_marker: payload.scope.compatibility_marker,
                query_identity: payload.scope.query_identity.clone(),
                material_constraint: payload.scope.material_constraint.clone(),
                knowledge_holder: payload.scope.knowledge_holder.clone(),
                audience: payload.scope.audience.clone(),
                version: payload
                    .base_version
                    .checked_add(1)
                    .context("scene scope version overflow")?,
                source_token: "pending".to_owned(),
                updated_at: payload.updated_at.clone(),
            };
            narrative_scene_scope::validate_binding(&next, &current.registry)?;
            next.source_token = narrative_scene_scope::source_token(&current.registry, &next)?;
            let before =
                canonical_scene_scope_snapshot(tx, &payload.project_id, &payload.scene_id)?;
            tx.execute(
                "INSERT INTO narrative_scene_scope_bindings (
                    project_id, scene_id, scene_incarnation_id, compatibility_marker,
                    query_identity_json, material_constraint_json, knowledge_holder_json,
                    audience_json, version, source_token, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(project_id, scene_id) DO UPDATE SET
                    scene_incarnation_id = excluded.scene_incarnation_id,
                    compatibility_marker = excluded.compatibility_marker,
                    query_identity_json = excluded.query_identity_json,
                    material_constraint_json = excluded.material_constraint_json,
                    knowledge_holder_json = excluded.knowledge_holder_json,
                    audience_json = excluded.audience_json,
                    version = excluded.version,
                    source_token = excluded.source_token,
                    updated_at = excluded.updated_at",
                params![
                    next.project_id,
                    next.scene_id,
                    next.scene_incarnation_id,
                    marker_text(next.compatibility_marker),
                    serde_json::to_string(&next.query_identity)?,
                    serde_json::to_string(&next.material_constraint)?,
                    serde_json::to_string(&next.knowledge_holder)?,
                    serde_json::to_string(&next.audience)?,
                    next.version,
                    next.source_token,
                    next.updated_at,
                ],
            )?;
            let after = canonical_scene_scope_snapshot(tx, &payload.project_id, &payload.scene_id)?;
            let append = append_canonical_and_narrative_change_in_tx(
                tx,
                &payload.project_id,
                &payload.session_id,
                &AppendChangeEvent {
                    event_uid: payload.event_uid.clone(),
                    scene_id: Some(payload.scene_id.clone()),
                    domain: "narrative".to_owned(),
                    op_type: "scene.scope.update".to_owned(),
                    entity_type: Some("scene_scope".to_owned()),
                    entity_id: Some(payload.scene_id.clone()),
                    payload: json!({
                        "requestId": payload.request_id,
                        "sceneId": payload.scene_id,
                        "scopeVersion": next.version,
                    })
                    .to_string(),
                    timestamp: event_timestamp(&payload.updated_at),
                },
                &AppendNarrativeChangeTransactionInput {
                    project_id: payload.project_id.clone(),
                    request_id: payload.request_id.clone(),
                    source_domain: "scene.scope.update".to_owned(),
                    source_change_event_uid: payload.event_uid.clone(),
                    cause_kind: NarrativeChangeCauseKind::Forward,
                    origin: NarrativeChangeOrigin::Human,
                    original_transaction_id: None,
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: None,
                    application_ids: Vec::new(),
                    occurred_at: payload.updated_at.clone(),
                    events: vec![NarrativeChangeEventInput {
                        object_key: json!({
                            "kind": SCENE_SCOPE_OBJECT_KIND,
                            "sceneId": payload.scene_id,
                        }),
                        change_kind: "metadata".to_owned(),
                        mutation_kind: "update".to_owned(),
                        before_version: before["binding"]["version"].as_i64(),
                        before_digest: Some(narrative_snapshot_digest(&before)?),
                        after_version: after["binding"]["version"].as_i64(),
                        after_digest: Some(narrative_snapshot_digest(&after)?),
                        changed_paths: vec!["/scope".to_owned()],
                        text_impact: None,
                        structural_impact: Some(json!({
                            "changedPaths": ["/scope"],
                            "scopeAuthorityChanged": true,
                        })),
                    }],
                },
            )?;
            let response = json!({
                "registry": current.registry,
                "binding": next,
                "__writeReceipt": {
                    "changeEventUid": payload.event_uid,
                    "maintenanceTransactionId": append.narrative.transaction_id,
                },
            });
            insert_idempotent_response(tx, &idempotency, &payload.project_id, &response)?;
            Ok(response)
        })
    })
}

pub fn update_narrative_scene_scope_registry(
    db: &Database,
    payload: NarrativeSceneScopeRegistryUpdatePayload,
) -> Result<Value> {
    require_write_identity(
        &payload.project_id,
        &[
            ("requestId", &payload.request_id),
            ("sessionId", &payload.session_id),
            ("eventUid", &payload.event_uid),
            ("updatedAt", &payload.updated_at),
        ],
    )?;
    anyhow::ensure!(
        payload.base_version >= 1,
        "scope registry baseVersion must be positive"
    );
    narrative_scene_scope::validate_registry(&payload.registry)?;
    let request_hash =
        canonical_write_payload_fingerprint("narrative_scene_scope_registry_update", &payload)?;
    let idempotency = IdempotencyRequest {
        domain: "narrative_scene_scope_registry_update",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "NEX_SCENE_SCOPE_REGISTRY_REQUEST_CONFLICT",
    };
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |tx| {
            if let Some(response) = load_idempotent_response(tx, &idempotency)? {
                return Ok(response);
            }
            let current = read_registry_row(tx, &payload.project_id)?;
            anyhow::ensure!(
                current.0 == payload.base_version,
                "NEX_SCENE_SCOPE_REGISTRY_VERSION_MISMATCH: expected base version {}, current is {}",
                payload.base_version,
                current.0
            );
            // SDEF/1 R3: a registry update cannot remove a reference the
            // project default uses. Checked before anything is written.
            super::scene_scope_default::ensure_project_default_fits_registry_in_tx(
                tx,
                &payload.project_id,
                &payload.registry,
            )?;
            let next_version = payload.base_version.checked_add(1).context("scope registry version overflow")?;
            let next_token = registry_source_token(&payload.registry, next_version)?;
            let before = canonical_scope_registry_snapshot(tx, &payload.project_id)?;
            let current_registry = read_registry_in_tx(tx, &payload.project_id)?;
            let mut bindings = Vec::new();
            let mut binding_befores = Vec::new();
            let scene_ids = {
                let mut statement = tx.prepare(
                    "SELECT scene_id FROM narrative_scene_scope_bindings
                      WHERE project_id = ?1 ORDER BY scene_id",
                )?;
                let scene_ids = statement
                    .query_map(params![payload.project_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                scene_ids
            };
            for scene_id in scene_ids {
                let before_scope =
                    canonical_scene_scope_snapshot(tx, &payload.project_id, &scene_id)?;
                let binding =
                    read_binding_in_tx(tx, &payload.project_id, &scene_id, &current_registry)?;
                narrative_scene_scope::validate_binding(&binding, &payload.registry)?;
                binding_befores.push((scene_id, before_scope));
                bindings.push(binding);
            }
            tx.execute(
                "INSERT INTO narrative_scope_registries (
                    project_id, registry_version, timeline_refs_json, worldline_refs_json,
                    narrative_layer_refs_json, version, source_token, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(project_id) DO UPDATE SET
                    registry_version = excluded.registry_version,
                    timeline_refs_json = excluded.timeline_refs_json,
                    worldline_refs_json = excluded.worldline_refs_json,
                    narrative_layer_refs_json = excluded.narrative_layer_refs_json,
                    version = excluded.version,
                    source_token = excluded.source_token,
                    updated_at = excluded.updated_at",
                params![
                    payload.project_id,
                    payload.registry.registry_version,
                    serde_json::to_string(&payload.registry.timeline_refs)?,
                    serde_json::to_string(&payload.registry.worldline_refs)?,
                    serde_json::to_string(&payload.registry.narrative_layer_refs)?,
                    next_version,
                    next_token,
                    payload.updated_at,
                ],
            )?;
            let registry = read_registry_in_tx(tx, &payload.project_id)?;
            for mut binding in bindings {
                binding.version = binding
                    .version
                    .checked_add(1)
                    .context("scene scope version overflow during registry update")?;
                binding.updated_at = payload.updated_at.clone();
                binding.source_token = narrative_scene_scope::source_token(&registry, &binding)?;
                let changed = tx.execute(
                    "UPDATE narrative_scene_scope_bindings
                        SET version = ?1, source_token = ?2, updated_at = ?3
                      WHERE project_id = ?4 AND scene_id = ?5",
                    params![
                        binding.version,
                        binding.source_token,
                        binding.updated_at,
                        payload.project_id,
                        binding.scene_id
                    ],
                )?;
                anyhow::ensure!(
                    changed == 1,
                    "scene scope binding disappeared during registry update"
                );
            }
            let after = canonical_scope_registry_snapshot(tx, &payload.project_id)?;
            let mut events = vec![NarrativeChangeEventInput {
                object_key: json!({
                    "kind": SCOPE_REGISTRY_OBJECT_KIND,
                    "projectId": payload.project_id,
                }),
                change_kind: "metadata".to_owned(),
                mutation_kind: "update".to_owned(),
                before_version: before["version"].as_i64(),
                before_digest: Some(narrative_snapshot_digest(&before)?),
                after_version: after["version"].as_i64(),
                after_digest: Some(narrative_snapshot_digest(&after)?),
                changed_paths: vec!["/registry".to_owned()],
                text_impact: None,
                structural_impact: Some(json!({
                    "changedPaths": ["/registry"],
                    "scopeAuthorityChanged": true,
                })),
            }];
            for (scene_id, before_scope) in binding_befores {
                let after_scope =
                    canonical_scene_scope_snapshot(tx, &payload.project_id, &scene_id)?;
                events.push(scene_scope_feed_event(
                    &scene_id,
                    &before_scope,
                    &after_scope,
                    vec![
                        "/registry".to_owned(),
                        "/binding/sourceToken".to_owned(),
                        "/binding/updatedAt".to_owned(),
                        "/binding/version".to_owned(),
                    ],
                )?);
            }
            let append = append_canonical_and_narrative_change_in_tx(
                tx,
                &payload.project_id,
                &payload.session_id,
                &AppendChangeEvent {
                    event_uid: payload.event_uid.clone(),
                    scene_id: None,
                    domain: "narrative".to_owned(),
                    op_type: "scene.scope-registry.update".to_owned(),
                    entity_type: Some("scope_registry".to_owned()),
                    entity_id: Some(payload.project_id.clone()),
                    payload: json!({
                        "requestId": payload.request_id,
                        "projectId": payload.project_id,
                        "registryVersion": next_version,
                    })
                    .to_string(),
                    timestamp: event_timestamp(&payload.updated_at),
                },
                &AppendNarrativeChangeTransactionInput {
                    project_id: payload.project_id.clone(),
                    request_id: payload.request_id.clone(),
                    source_domain: "scene.scope-registry.update".to_owned(),
                    source_change_event_uid: payload.event_uid.clone(),
                    cause_kind: NarrativeChangeCauseKind::Forward,
                    origin: NarrativeChangeOrigin::Human,
                    original_transaction_id: None,
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: None,
                    application_ids: Vec::new(),
                    occurred_at: payload.updated_at.clone(),
                    events,
                },
            )?;
            let response = json!({
                "registry": registry,
                "registryRevision": next_version,
                "registrySourceToken": next_token,
                "registryUpdatedAt": payload.updated_at,
                "__writeReceipt": {
                    "changeEventUid": payload.event_uid,
                    "maintenanceTransactionId": append.narrative.transaction_id,
                },
            });
            insert_idempotent_response(tx, &idempotency, &payload.project_id, &response)?;
            Ok(response)
        })
    })
}

fn read_registry_row(conn: &Connection, project_id: &str) -> Result<(i64, String, String)> {
    #[cfg(test)]
    project_read_probe::record(project_read_probe::Read::RegistryRow);
    let row: Option<(i64, String, String)> = conn
        .query_row(
            "SELECT version, source_token, updated_at
               FROM narrative_scope_registries WHERE project_id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match row {
        Some(row) => Ok(row),
        None => anyhow::bail!(
            "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scope registry row is missing for project '{project_id}'"
        ),
    }
}

#[derive(Clone, Debug)]
pub(crate) struct MaterialSceneScope {
    pub(crate) binding: NarrativeSceneScopeBindingV1,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct MaterialSceneScopeCache {
    pub(crate) scopes: Vec<MaterialSceneScope>,
    /// Missing or invalid rows are candidate-local. A cache entry here is
    /// deliberately distinct from a preload/query failure.
    pub(crate) unavailable_scene_ids: BTreeSet<String>,
}

fn material_scope_text(value: SqlValue) -> Result<String> {
    match value {
        SqlValue::Text(value) => Ok(value),
        _ => anyhow::bail!("material scene scope text column has an invalid SQLite type"),
    }
}

fn material_scope_integer(value: SqlValue) -> Result<i64> {
    match value {
        SqlValue::Integer(value) => Ok(value),
        _ => anyhow::bail!("material scene scope integer column has an invalid SQLite type"),
    }
}

#[cfg(test)]
thread_local! {
    pub(crate) static MATERIAL_SCOPE_PRELOAD_QUERY_COUNT: Cell<usize> = const { Cell::new(0) };
}

/// Load every unique scene scope needed by one retrieval snapshot in one
/// bounded query. Admission consumes this immutable result; it must not
/// issue one scope read for each candidate/material pair.
pub(crate) fn preload_material_scene_scopes(
    conn: &Connection,
    project_id: &str,
    material_source_keys: &[String],
) -> Result<MaterialSceneScopeCache> {
    let scene_ids = material_source_keys
        .iter()
        .filter_map(|source_key| source_key.strip_prefix("project:scene:"))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    if scene_ids.is_empty() {
        return Ok(MaterialSceneScopeCache::default());
    }
    let storage_tables_present = table_exists(conn, "narrative_scope_registries")?
        && table_exists(conn, "narrative_scene_scope_bindings")?;
    if !storage_tables_present {
        return Ok(MaterialSceneScopeCache {
            scopes: Vec::new(),
            unavailable_scene_ids: scene_ids,
        });
    }
    let registry = match read_registry_in_tx(conn, project_id) {
        Ok(value) => value,
        Err(error)
            if error.downcast_ref::<rusqlite::Error>().is_some()
                || error.downcast_ref::<std::io::Error>().is_some() =>
        {
            return Err(error)
        }
        Err(_) => {
            return Ok(MaterialSceneScopeCache {
                scopes: Vec::new(),
                unavailable_scene_ids: scene_ids,
            })
        }
    };
    let placeholders = (0..scene_ids.len())
        .map(|index| format!("?{}", index + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT b.scene_id, b.scene_incarnation_id, b.compatibility_marker,
                b.query_identity_json, b.material_constraint_json,
                b.knowledge_holder_json, b.version, b.audience_json,
                b.source_token, b.updated_at,
                CASE WHEN EXISTS (
                    SELECT 1 FROM tree_nodes scene
                     WHERE scene.id = b.scene_id AND scene.project_id = b.project_id
                       AND scene.node_type = 'scene'
                ) THEN 1 ELSE 0 END,
                CASE WHEN json_valid(b.knowledge_holder_json) THEN
                    CASE WHEN json_extract(b.knowledge_holder_json, '$.kind') = 'character'
                         THEN (SELECT COUNT(*) FROM codex_entries entry
                                 WHERE entry.id = json_extract(b.knowledge_holder_json, '$.ref')
                                   AND entry.project_id = b.project_id
                                   AND entry.type = 'character')
                         ELSE 1 END
                    ELSE 0 END,
                CASE WHEN json_valid(b.audience_json) THEN
                    CASE WHEN json_extract(b.audience_json, '$.kind') = 'character'
                         THEN (SELECT COUNT(*) FROM codex_entries entry
                                 WHERE entry.id = json_extract(b.audience_json, '$.ref')
                                   AND entry.project_id = b.project_id
                                   AND entry.type = 'character')
                         ELSE 1 END
                    ELSE 0 END
           FROM narrative_scene_scope_bindings b
          WHERE b.project_id = ?1 AND b.scene_id IN ({placeholders})
          ORDER BY b.scene_id"
    );
    #[cfg(test)]
    MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.set(count.get() + 1));
    let mut statement = conn.prepare(&sql)?;
    let rows = statement
        .query_map(
            rusqlite::params_from_iter(
                std::iter::once(project_id).chain(scene_ids.iter().map(String::as_str)),
            ),
            |row| {
                Ok((
                    row.get::<_, SqlValue>(0)?,
                    row.get::<_, SqlValue>(1)?,
                    row.get::<_, SqlValue>(2)?,
                    row.get::<_, SqlValue>(3)?,
                    row.get::<_, SqlValue>(4)?,
                    row.get::<_, SqlValue>(5)?,
                    row.get::<_, SqlValue>(6)?,
                    row.get::<_, SqlValue>(7)?,
                    row.get::<_, SqlValue>(8)?,
                    row.get::<_, SqlValue>(9)?,
                    row.get::<_, SqlValue>(10)?,
                    row.get::<_, SqlValue>(11)?,
                    row.get::<_, SqlValue>(12)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut scopes = Vec::with_capacity(rows.len());
    let mut seen_scene_ids = BTreeSet::new();
    let mut unavailable_scene_ids = BTreeSet::new();
    for (
        scene_id,
        incarnation,
        marker,
        query_identity,
        material_constraint,
        knowledge_holder,
        version,
        audience,
        source_token,
        updated_at,
        scene_owned,
        knowledge_holder_owned,
        audience_owned,
    ) in rows
    {
        let scene_id = match material_scope_text(scene_id) {
            Ok(value) => value,
            Err(_) => {
                unavailable_scene_ids.extend(scene_ids.iter().cloned());
                continue;
            }
        };
        seen_scene_ids.insert(scene_id.clone());
        // A missing or corrupt scene row only invalidates candidates that
        // reference that scene. Keep SQL/I/O failures above as hard errors so
        // a valid candidate is not suppressed by another roster entry.
        let scope = (|| -> Result<MaterialSceneScope> {
            let incarnation = material_scope_text(incarnation)?;
            let marker = material_scope_text(marker)?;
            let query_identity = material_scope_text(query_identity)?;
            let material_constraint = material_scope_text(material_constraint)?;
            let knowledge_holder = material_scope_text(knowledge_holder)?;
            let version = material_scope_integer(version)?;
            let audience = material_scope_text(audience)?;
            let source_token = material_scope_text(source_token)?;
            let updated_at = material_scope_text(updated_at)?;
            let scene_owned = material_scope_integer(scene_owned)?;
            let knowledge_holder_owned = material_scope_integer(knowledge_holder_owned)?;
            let audience_owned = material_scope_integer(audience_owned)?;
            anyhow::ensure!(
                scene_owned == 1,
                "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: material scope scene '{scene_id}' is missing or belongs to another project"
            );
            let mut binding = parse_binding_row(
                project_id,
                &scene_id,
                (
                    incarnation,
                    marker,
                    query_identity,
                    material_constraint,
                    knowledge_holder,
                    version,
                    audience,
                    source_token,
                ),
            )?;
            binding.updated_at = updated_at;
            narrative_scene_scope::validate_binding(&binding, &registry)?;
            if matches!(
                binding.knowledge_holder,
                NarrativeScopePrincipalV1::Character { .. }
            ) {
                anyhow::ensure!(
                    knowledge_holder_owned == 1,
                    "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: material knowledge-holder character is not in project '{project_id}'"
                );
            }
            if matches!(
                binding.audience,
                NarrativeScopePrincipalV1::Character { .. }
            ) {
                anyhow::ensure!(
                    audience_owned == 1,
                    "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: material audience character is not in project '{project_id}'"
                );
            }
            let expected_token = narrative_scene_scope::source_token(&registry, &binding)?;
            anyhow::ensure!(
                binding.source_token == expected_token,
                "NEX_SCENE_SCOPE_SOURCE_TOKEN_INVALID: material scene scope source token does not match its state"
            );
            Ok(MaterialSceneScope { binding })
        })();
        if let Ok(scope) = scope {
            scopes.push(scope);
        } else {
            unavailable_scene_ids.insert(scene_id);
        }
    }
    unavailable_scene_ids.extend(
        scene_ids
            .into_iter()
            .filter(|scene_id| !seen_scene_ids.contains(scene_id)),
    );
    Ok(MaterialSceneScopeCache {
        scopes,
        unavailable_scene_ids,
    })
}

pub(crate) fn select_material_scene_scopes(
    material_scope_cache: &MaterialSceneScopeCache,
    material_source_keys: &[String],
) -> Result<Vec<MaterialSceneScope>> {
    let scene_ids = material_source_keys
        .iter()
        .filter_map(|source_key| source_key.strip_prefix("project:scene:"))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let by_scene = material_scope_cache
        .scopes
        .iter()
        .map(|scope| (scope.binding.scene_id.as_str(), scope))
        .collect::<BTreeMap<_, _>>();
    scene_ids
        .into_iter()
        .map(|scene_id| {
            if material_scope_cache
                .unavailable_scene_ids
                .contains(&scene_id)
            {
                return Err(anyhow::anyhow!(
                    "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: material scope row is unavailable for scene '{scene_id}'"
                ));
            }
            by_scene
                .get(scene_id.as_str())
                .cloned()
                .cloned()
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: material scope row is missing for scene '{scene_id}'"
                    )
                })
        })
        .collect()
}

/// An active Scope control with its dependency identity decoded once.
///
/// Decoding a `scope-dependency-projection-v1` Source key (hex, JSON and a
/// canonical re-encoding) depends only on the key, so a Build candidate does it
/// at build instead of on every query. `identity` is `Some` exactly when the
/// kind is `scope-dependency-projection-v1` and the key decodes; every other
/// control keeps `None`, the same outcome the per-query decode gave.
#[derive(Debug)]
pub(crate) struct ParsedScopeControl {
    control: super::human_material_basis::MaterialSourceBasisEntry,
    identity: Option<grimodex_core::narrative_scope_dependency_projection::ScopeDependencyIdentity>,
}

impl ParsedScopeControl {
    pub(crate) fn parse(control: &super::human_material_basis::MaterialSourceBasisEntry) -> Self {
        use grimodex_core::narrative_scope_dependency_projection::ScopeDependencyIdentity;
        let identity = (control.source_kind == "scope-dependency-projection-v1")
            .then(|| ScopeDependencyIdentity::from_source_key(&control.source_key).ok())
            .flatten();
        Self {
            control: control.clone(),
            identity,
        }
    }

    pub(crate) fn parse_all(
        controls: &[super::human_material_basis::MaterialSourceBasisEntry],
    ) -> Vec<Self> {
        controls.iter().map(Self::parse).collect()
    }
}

/// `projection_revision` answers for one query pass.
///
/// `projection_revision(identity, authority)` is a pure function of the decoded
/// identity (a bijection with the control's Source key) and the authority. One
/// pass over the candidates of one query reads one authority, so candidates
/// that share a control key share the answer. Create one memo per pass and use
/// it with that pass's authority only; nothing here outlives the pass or is
/// shared between queries.
#[derive(Debug, Default)]
pub(crate) struct ProjectionRevisionMemo {
    answers: std::collections::HashMap<String, Option<String>>,
    #[cfg(debug_assertions)]
    authority_address: Option<usize>,
}

impl ProjectionRevisionMemo {
    fn matches(
        &mut self,
        source_key: &str,
        identity: &grimodex_core::narrative_scope_dependency_projection::ScopeDependencyIdentity,
        authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
        revision_token: &str,
    ) -> bool {
        #[cfg(debug_assertions)]
        {
            let address = authority as *const _ as usize;
            debug_assert_eq!(
                *self.authority_address.get_or_insert(address),
                address,
                "a ProjectionRevisionMemo serves one authority"
            );
        }
        if let Some(answer) = self.answers.get(source_key) {
            return answer.as_deref() == Some(revision_token);
        }
        let answer = grimodex_core::narrative_scope_dependency_projection::projection_revision(
            identity, authority,
        )
        .ok();
        let matches = answer.as_deref() == Some(revision_token);
        self.answers.insert(source_key.to_owned(), answer);
        matches
    }
}

pub(crate) fn check_material_constraints(
    material_scopes: &[MaterialSceneScope],
    query: &super::retrieval_admission::RetrievalQueryContext,
    authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
    active_scope_controls: &[ParsedScopeControl],
    owning_run_id: &str,
) -> Option<super::retrieval_admission::RevisionEligibilityReason> {
    check_material_constraints_with_memo(
        material_scopes,
        query,
        authority,
        active_scope_controls,
        owning_run_id,
        &mut ProjectionRevisionMemo::default(),
    )
}

/// `check_material_constraints` with the pass's `projection_revision` memo.
pub(crate) fn check_material_constraints_with_memo(
    material_scopes: &[MaterialSceneScope],
    query: &super::retrieval_admission::RetrievalQueryContext,
    authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
    active_scope_controls: &[ParsedScopeControl],
    owning_run_id: &str,
    memo: &mut ProjectionRevisionMemo,
) -> Option<super::retrieval_admission::RevisionEligibilityReason> {
    for material_scope in material_scopes {
        let scope = &material_scope.binding;
        if scope.compatibility_marker == NarrativeScopeCompatibilityMarkerV1::LegacyAbsent {
            continue;
        }
        // A non-legacy A1 material row is unavailable until disclosure has
        // verified exactly one existing Native scope control. Never
        // re-authorize a historical row from the current DB scope alone.
        let exact_current_control_count = active_scope_controls
            .iter()
            .filter(|parsed| {
                let control = &parsed.control;
                match control.source_kind.as_str() {
                    "project-scope-authority" => {
                        control.source_key == query.scope_authority_source_key
                            && control.revision_token == query.scope_authority_revision_token
                    }
                    "scope-dependency-projection-v1" => {
                        parsed.identity.as_ref().is_some_and(|identity| {
                            identity.project_id == query.project_id
                                && identity.run_id == owning_run_id
                                && !identity.secret
                                && memo.matches(
                                    &control.source_key,
                                    identity,
                                    authority,
                                    &control.revision_token,
                                )
                        })
                    }
                    _ => false,
                }
            })
            .count();
        if exact_current_control_count != 1 {
            return Some(
                super::retrieval_admission::RevisionEligibilityReason::MaterialAuthorityUnavailable,
            );
        }
        if scope.compatibility_marker == NarrativeScopeCompatibilityMarkerV1::Unknown {
            return Some(super::retrieval_admission::RevisionEligibilityReason::ScopeUnsupported);
        }
        for (constraint, identity) in [
            (&scope.material_constraint.timeline, &query.timeline),
            (&scope.material_constraint.worldline, &query.worldline),
            (
                &scope.material_constraint.narrative_layer,
                &query.narrative_layer,
            ),
        ] {
            let matches = match constraint {
                narrative_scene_scope::NarrativeScopeConstraintV1::Any => true,
                narrative_scene_scope::NarrativeScopeConstraintV1::Exact { reference } => {
                    matches!(identity, super::retrieval_admission::QueryIdentityState::Resolved(value) if value == reference)
                }
                narrative_scene_scope::NarrativeScopeConstraintV1::Unresolved { .. } => false,
            };
            if !matches {
                return Some(
                    super::retrieval_admission::RevisionEligibilityReason::ScopeUnsupported,
                );
            }
        }
        for (principal, identity) in [
            (&scope.knowledge_holder, &query.knowledge_holder),
            (&scope.audience, &query.audience),
        ] {
            let expected = match principal {
                NarrativeScopePrincipalV1::Reader {} => "reader".to_owned(),
                NarrativeScopePrincipalV1::Character { reference } => {
                    format!("character:{reference}")
                }
            };
            if !matches!(
                identity,
                super::retrieval_admission::QueryIdentityState::Resolved(value)
                    if value == &expected
            ) {
                return Some(
                    super::retrieval_admission::RevisionEligibilityReason::ScopeUnsupported,
                );
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn seed_migrated_db(db: &Database) {
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('p1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name)
                 VALUES ('c1', 'p1', 'character', 'Character')",
                [],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
                 VALUES ('s1', 'p1', 'scene', 'Scene', 'a0')",
                [],
            )?;
            ensure_scene_scope_binding_in_tx(
                conn,
                "p1",
                "s1",
                "2026-09-13T00:00:00.000Z",
                crate::narrative_extraction::SceneScopeInit::UnknownRepairOrRestore,
            )?;
            Ok(())
        })
        .expect("seed database");
    }

    fn migrated_db_at(path: &Path) -> Database {
        let db = Database::new(path).expect("open database");
        seed_migrated_db(&db);
        db
    }

    fn migrated_db() -> Database {
        migrated_db_at(Path::new(":memory:"))
    }

    fn scope_digest(db: &Database) -> String {
        db.with_read_transaction(|conn| {
            Ok(
                super::super::project_scope_authority::load_live_project_scope_authority(
                    conn,
                    "p1",
                    "project:scope-authority:p1",
                )?
                .source
                .revision_token,
            )
        })
        .expect("scope authority digest")
    }

    #[test]
    fn legacy_binding_is_explicitly_unresolved() {
        let registry = initial_registry();
        let binding =
            legacy_binding("p1", "s1", "2026-01-01T00:00:00Z".into(), &registry).expect("binding");
        assert_eq!(
            binding.compatibility_marker,
            NarrativeScopeCompatibilityMarkerV1::LegacyAbsent
        );
        assert!(narrative_scene_scope::is_unresolved(
            &binding.query_identity.timeline
        ));
    }

    #[test]
    fn ordinary_scene_refresh_keeps_incarnation_and_marker_separate() {
        let db = migrated_db();
        let before = db
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, "p1", "s1"))
            .expect("read scope before ordinary edit");
        let refresh_event = db
            .with_conn(|conn| {
                refresh_scene_scope_source_token_in_tx(conn, "p1", "s1", "2026-09-13T00:04:00.000Z")
            })
            .expect("refresh scope after ordinary edit");
        assert_eq!(
            refresh_event.object_key,
            json!({ "kind": SCENE_SCOPE_OBJECT_KIND, "sceneId": "s1" })
        );
        assert_eq!(
            refresh_event
                .structural_impact
                .as_ref()
                .expect("scope refresh impact")["scopeAuthorityChanged"],
            true
        );
        let after = db
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, "p1", "s1"))
            .expect("read scope after ordinary edit");
        assert_eq!(
            after.binding.scene_incarnation_id,
            before.binding.scene_incarnation_id
        );
        assert_eq!(
            after.binding.compatibility_marker,
            before.binding.compatibility_marker
        );
        assert_ne!(after.binding.source_token, before.binding.source_token);
        assert_eq!(after.binding.updated_at, "2026-09-13T00:04:00.000Z");
        assert_eq!(after.binding.version, before.binding.version + 1);
    }

    #[test]
    fn authority_digest_tracks_native_revisions_but_not_the_trees_own_version() {
        let db = migrated_db();
        let digest_a = scope_digest(&db);
        let same_timestamp = "2026-09-13T00:10:00.000Z";
        update_narrative_scene_scope_registry(
            &db,
            NarrativeSceneScopeRegistryUpdatePayload {
                project_id: "p1".into(),
                request_id: "registry-digest-b".into(),
                session_id: "session-digest".into(),
                event_uid: "registry-digest-b-event".into(),
                base_version: 1,
                updated_at: same_timestamp.into(),
                // SDEF/1 R13: A is now the main-line vocabulary, so B is a
                // different (empty) vocabulary.
                registry: NarrativeSceneScopeRegistryV1 {
                    registry_version: NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID.into(),
                    timeline_refs: Vec::new(),
                    worldline_refs: Vec::new(),
                    narrative_layer_refs: Vec::new(),
                },
            },
        )
        .expect("registry A to B");
        let digest_b = scope_digest(&db);
        update_narrative_scene_scope_registry(
            &db,
            NarrativeSceneScopeRegistryUpdatePayload {
                project_id: "p1".into(),
                request_id: "registry-digest-a-again".into(),
                session_id: "session-digest".into(),
                event_uid: "registry-digest-a-again-event".into(),
                base_version: 2,
                updated_at: same_timestamp.into(),
                registry: initial_registry(),
            },
        )
        .expect("registry B to A");
        let digest_a_again = scope_digest(&db);
        assert_ne!(digest_a, digest_b);
        assert_ne!(digest_b, digest_a_again);
        assert_ne!(
            digest_a, digest_a_again,
            "Native registry OCC must prevent A->B->A token reuse"
        );

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET version = version + 1, updated_at = ?1 WHERE id = 's1'",
                params![same_timestamp],
            )?;
            Ok(())
        })
        .expect("bump the tree row's own version and updatedAt");
        let digest_after_tree_bump = scope_digest(&db);
        assert_eq!(
            digest_a_again, digest_after_tree_bump,
            "titles, bodies and labels move tree_nodes.version/updated_at; ADR009 keeps them \
             out of the project Scope authority"
        );
    }

    #[test]
    fn batch_refresh_advances_each_named_scene_once_and_moves_the_authority_digest() {
        let db = migrated_db();
        db.with_conn(|conn| {
            for scene_id in ["s2", "s3"] {
                conn.execute(
                    "INSERT INTO tree_nodes
                        (id, project_id, node_type, title, sort_order)
                     VALUES (?1, 'p1', 'scene', ?1, ?1)",
                    [scene_id],
                )?;
                ensure_scene_scope_binding_in_tx(
                    conn,
                    "p1",
                    scene_id,
                    "2026-09-13T00:05:00.000Z",
                    crate::narrative_extraction::SceneScopeInit::UnknownRepairOrRestore,
                )?;
            }
            Ok(())
        })
        .expect("seed additional scenes");
        let version = |db: &Database, scene_id: &str| {
            db.with_read_transaction(|conn| {
                Ok(read_narrative_scene_scope(conn, "p1", scene_id)?
                    .binding
                    .version)
            })
            .expect("read binding version")
        };
        let before = scope_digest(&db);

        // The BTreeSet argument already makes the Scene ids unique. Out-of-order
        // input still yields one refresh per Scene and events in ascending
        // Scene id order; the untouched Scene keeps its generation.
        let scene_ids = ["s3", "s1"]
            .into_iter()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        let events = db
            .with_conn(|conn| {
                refresh_scene_scope_source_tokens_in_tx(
                    conn,
                    "p1",
                    &scene_ids,
                    "2026-09-13T00:06:00.000Z",
                )
            })
            .expect("batch refresh");
        assert_eq!(
            events
                .iter()
                .map(|event| event.object_key.clone())
                .collect::<Vec<_>>(),
            vec![
                json!({ "kind": SCENE_SCOPE_OBJECT_KIND, "sceneId": "s1" }),
                json!({ "kind": SCENE_SCOPE_OBJECT_KIND, "sceneId": "s3" }),
            ]
        );
        assert_eq!(version(&db, "s1"), 2);
        assert_eq!(version(&db, "s2"), 1);
        assert_eq!(version(&db, "s3"), 2);
        let after = scope_digest(&db);
        assert_ne!(before, after);

        let none = db
            .with_conn(|conn| {
                refresh_scene_scope_source_tokens_in_tx(
                    conn,
                    "p1",
                    &BTreeSet::new(),
                    "2026-09-13T00:07:00.000Z",
                )
            })
            .expect("empty batch refresh");
        assert!(none.is_empty(), "an empty set refreshes nothing");
        assert_eq!(scope_digest(&db), after);
    }

    #[test]
    fn authority_digest_survives_cold_reopen() {
        let path = std::env::temp_dir().join(format!("grimodex-a1-cold-{}.sqlite", Uuid::new_v4()));
        let before = {
            let db = migrated_db_at(&path);
            scope_digest(&db)
        };
        let reopened = Database::new(&path).expect("reopen database");
        let after = scope_digest(&reopened);
        assert_eq!(before, after);
        drop(reopened);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn referenced_character_mutation_rejects_and_restore_invalidates_scope() {
        let db = migrated_db();
        db.with_conn(|conn| {
            let registry = read_registry_in_tx(conn, "p1")?;
            let mut binding = read_binding_in_tx(conn, "p1", "s1", &registry)?;
            binding.compatibility_marker = NarrativeScopeCompatibilityMarkerV1::Explicit;
            binding.knowledge_holder = NarrativeScopePrincipalV1::Character {
                reference: "c1".into(),
            };
            binding.version += 1;
            binding.source_token = narrative_scene_scope::source_token(&registry, &binding)?;
            conn.execute(
                "UPDATE narrative_scene_scope_bindings
                    SET compatibility_marker = ?1,
                        query_identity_json = ?2,
                        material_constraint_json = ?3,
                        knowledge_holder_json = ?4,
                        audience_json = ?5,
                        version = ?6,
                        source_token = ?7
                  WHERE project_id = 'p1' AND scene_id = 's1'",
                params![
                    marker_text(binding.compatibility_marker),
                    serde_json::to_string(&binding.query_identity)?,
                    serde_json::to_string(&binding.material_constraint)?,
                    serde_json::to_string(&binding.knowledge_holder)?,
                    serde_json::to_string(&binding.audience)?,
                    binding.version,
                    binding.source_token,
                ],
            )?;
            Ok(())
        })
        .expect("seed character principal reference");

        db.with_conn(|conn| {
            let delete =
                ensure_character_reference_mutation_allowed_in_tx(conn, "p1", "c1", "delete")
                    .expect_err("delete of referenced character must be rejected");
            assert!(delete
                .to_string()
                .contains("NEX_SCENE_SCOPE_CHARACTER_REFERENCED"));
            let change_type = ensure_character_reference_mutation_allowed_in_tx(
                conn,
                "p1",
                "c1",
                "change the type of",
            )
            .expect_err("type change of referenced character must be rejected");
            assert!(change_type
                .to_string()
                .contains("NEX_SCENE_SCOPE_CHARACTER_REFERENCED"));
            Ok(())
        })
        .expect("check character mutation guard");

        let before = db
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, "p1", "s1"))
            .expect("read referenced scope");
        let invalidation_events = db
            .with_conn(|conn| {
                invalidate_character_references_with_events_in_tx(
                    conn,
                    "p1",
                    "c1",
                    "2026-09-13T00:11:00.000Z",
                )
            })
            .expect("invalidate restored character reference");
        assert_eq!(invalidation_events.len(), 1);
        assert_eq!(
            invalidation_events[0].object_key,
            json!({ "kind": SCENE_SCOPE_OBJECT_KIND, "sceneId": "s1" })
        );
        assert_eq!(
            invalidation_events[0]
                .structural_impact
                .as_ref()
                .expect("scope invalidation impact")["scopeAuthorityChanged"],
            true
        );
        let after = db
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, "p1", "s1"))
            .expect("read invalidated scope");
        assert_eq!(
            after.binding.compatibility_marker,
            NarrativeScopeCompatibilityMarkerV1::Unknown
        );
        assert_eq!(
            after.binding.knowledge_holder,
            NarrativeScopePrincipalV1::Reader {}
        );
        assert!(after.binding.version > before.binding.version);
        assert_ne!(after.binding.source_token, before.binding.source_token);
        db.with_conn(|conn| {
            ensure_character_reference_mutation_allowed_in_tx(conn, "p1", "c1", "delete")
        })
        .expect("unknown binding no longer keeps stale character reference");
    }

    #[test]
    fn missing_scope_rows_fail_closed_and_id_reuse_gets_new_incarnation() {
        let db = migrated_db();
        let old_incarnation = db
            .with_read_transaction(|conn| {
                read_narrative_scene_scope(conn, "p1", "s1")
                    .map(|scope| scope.binding.scene_incarnation_id)
            })
            .expect("read old incarnation");
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_scene_scope_bindings WHERE project_id = 'p1' AND scene_id = 's1'",
                [],
            )?;
            Ok(())
        })
        .expect("remove scope row for corruption test");
        let missing = db
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, "p1", "s1"))
            .expect_err("missing scope row must not synthesize legacy binding");
        assert!(missing
            .to_string()
            .contains("NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE"));

        db.with_conn(|conn| {
            conn.execute("DELETE FROM tree_nodes WHERE id = 's1'", [])?;
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
                 VALUES ('s1', 'p1', 'scene', 'Reused scene', 'a0')",
                [],
            )?;
            ensure_scene_scope_binding_in_tx(
                conn,
                "p1",
                "s1",
                "2026-09-13T00:12:00.000Z",
                crate::narrative_extraction::SceneScopeInit::UnknownRepairOrRestore,
            )?;
            Ok(())
        })
        .expect("reuse scene id with a new persisted binding");
        let reused = db
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, "p1", "s1"))
            .expect("read reused scene scope");
        assert_ne!(old_incarnation, reused.binding.scene_incarnation_id);
        assert_ne!(reused.binding.scene_incarnation_id, "legacy:s1");

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_scene_scope_bindings
                    SET source_token = ?1
                  WHERE project_id = 'p1' AND scene_id = 's1'",
                params!["sha256:0000000000000000000000000000000000000000000000000000000000000000",],
            )?;
            Ok(())
        })
        .expect("corrupt persisted token for fail-closed test");
        let persisted = db
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, "p1", "s1"))
            .expect_err("invalid persisted token must fail closed");
        assert!(persisted
            .to_string()
            .contains("NEX_SCENE_SCOPE_SOURCE_TOKEN_INVALID"));
    }

    #[test]
    fn material_scope_preload_query_count_scales_with_unique_scenes() {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        let db = migrated_db();
        db.with_conn(|conn| {
            for scene_id in ["s2", "s3", "s4"] {
                conn.execute(
                    "INSERT INTO tree_nodes
                        (id, project_id, node_type, title, sort_order)
                     VALUES (?1, 'p1', 'scene', ?1, ?1)",
                    [scene_id],
                )?;
                ensure_scene_scope_binding_in_tx(
                    conn,
                    "p1",
                    scene_id,
                    "2026-09-13T00:13:00.000Z",
                    crate::narrative_extraction::SceneScopeInit::UnknownRepairOrRestore,
                )?;
            }
            Ok(())
        })
        .expect("seed material scenes");

        let measure = |keys: Vec<String>| -> Result<(usize, usize)> {
            db.with_conn(|conn| {
                let select_count = Arc::new(AtomicUsize::new(0));
                let count_for_hook = Arc::clone(&select_count);
                conn.authorizer(Some(move |context: AuthContext<'_>| {
                    if matches!(context.action, AuthAction::Select) {
                        count_for_hook.fetch_add(1, Ordering::SeqCst);
                    }
                    Authorization::Allow
                }))?;
                let scopes = preload_material_scene_scopes(conn, "p1", &keys)?;
                let count = select_count.load(Ordering::SeqCst);
                conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
                Ok((count, scopes.scopes.len()))
            })
        };

        let (single_query_count, single_scope_count) = measure(vec![
            "project:scene:s1".to_owned(),
            "project:scene:s1".to_owned(),
        ])
        .expect("preload one unique material scene");
        let (many_query_count, many_scope_count) = measure(
            ["s1", "s2", "s3", "s4"]
                .into_iter()
                .map(|scene_id| format!("project:scene:{scene_id}"))
                .collect(),
        )
        .expect("preload many unique material scenes");
        assert_eq!(single_scope_count, 1);
        assert_eq!(many_scope_count, 4);
        assert_eq!(
            single_query_count, many_query_count,
            "scope SQL must be one bounded snapshot query, not candidate x material"
        );
    }

    #[test]
    fn registry_and_scene_scope_writers_are_occ_and_feed_bound() {
        let db = migrated_db();
        update_narrative_scene_scope_registry(
            &db,
            NarrativeSceneScopeRegistryUpdatePayload {
                project_id: "p1".into(),
                request_id: "registry-request-1".into(),
                session_id: "session-1".into(),
                event_uid: "registry-event-1".into(),
                base_version: 1,
                updated_at: "2026-09-13T00:01:00.000Z".into(),
                registry: NarrativeSceneScopeRegistryV1 {
                    registry_version: "narrative-scene-scope-registry/1".into(),
                    timeline_refs: vec!["timeline:main".into()],
                    worldline_refs: vec!["worldline:prime".into()],
                    narrative_layer_refs: vec!["layer:manuscript".into()],
                },
            },
        )
        .expect("registry update");

        let before = db
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, "p1", "s1"))
            .expect("read initial scope");
        let incarnation = before.binding.scene_incarnation_id.clone();
        let initial_token = before.binding.source_token.clone();
        assert_eq!(
            before.binding.compatibility_marker,
            NarrativeScopeCompatibilityMarkerV1::Unknown
        );

        let result = update_narrative_scene_scope(
            &db,
            NarrativeSceneScopeUpdatePayload {
                project_id: "p1".into(),
                scene_id: "s1".into(),
                request_id: "scope-request-1".into(),
                session_id: "session-1".into(),
                event_uid: "scope-event-1".into(),
                base_version: before.binding.version,
                updated_at: "2026-09-13T00:02:00.000Z".into(),
                scope: NarrativeSceneScopeUpdateV1 {
                    schema_version: 1,
                    compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
                    query_identity: NarrativeSceneQueryIdentityV1 {
                        timeline: narrative_scene_scope::NarrativeScopeConstraintV1::Exact {
                            reference: "timeline:main".into(),
                        },
                        worldline: narrative_scene_scope::NarrativeScopeConstraintV1::Exact {
                            reference: "worldline:prime".into(),
                        },
                        narrative_layer: narrative_scene_scope::NarrativeScopeConstraintV1::Exact {
                            reference: "layer:manuscript".into(),
                        },
                    },
                    material_constraint: default_material_constraint(),
                    knowledge_holder: NarrativeScopePrincipalV1::Character {
                        reference: "c1".into(),
                    },
                    audience: NarrativeScopePrincipalV1::Reader {},
                },
            },
        )
        .expect("scope update");
        let updated = result["binding"].clone();
        assert_eq!(updated["sceneIncarnationId"], incarnation);
        assert_eq!(updated["compatibilityMarker"], "explicit");
        assert_ne!(updated["sourceToken"], initial_token);
        assert_eq!(updated["version"], 3);

        let stale = update_narrative_scene_scope(
            &db,
            NarrativeSceneScopeUpdatePayload {
                project_id: "p1".into(),
                scene_id: "s1".into(),
                request_id: "scope-request-stale".into(),
                session_id: "session-1".into(),
                event_uid: "scope-event-stale".into(),
                base_version: 1,
                updated_at: "2026-09-13T00:03:00.000Z".into(),
                scope: NarrativeSceneScopeUpdateV1 {
                    schema_version: 1,
                    compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
                    query_identity: default_query_identity(),
                    material_constraint: default_material_constraint(),
                    knowledge_holder: NarrativeScopePrincipalV1::Reader {},
                    audience: NarrativeScopePrincipalV1::Reader {},
                },
            },
        )
        .expect_err("stale scope update must be rejected");
        assert!(stale
            .to_string()
            .contains("NEX_SCENE_SCOPE_VERSION_MISMATCH"));

        let feed_count = db
            .with_read_transaction(|conn| {
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_change_events e
                       JOIN narrative_change_transactions t
                         ON t.project_id = e.project_id AND t.id = e.transaction_id
                      WHERE e.project_id = 'p1'
                        AND t.source_domain IN ('scene.scope.update', 'scene.scope-registry.update')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(Into::into)
            })
            .expect("read scope feed");
        assert_eq!(feed_count, 3);
    }

    /// The extension digest as it was built before DR-GRW-5: every entry held
    /// in a `Vec<Value>` and the whole document built by `json!`, which copies
    /// that vector once more. The streamed digest must equal this one for any
    /// registry, revision, source token and entry list.
    fn scope_extension_digest_reference(
        registry: &NarrativeSceneScopeRegistryV1,
        registry_revision: i64,
        registry_source_token: &str,
        bindings: Vec<Value>,
    ) -> String {
        grimodex_core::canonical_json_digest(&json!({
            "contractId": narrative_scene_scope::NARRATIVE_SCENE_SCOPE_CONTRACT_ID,
            "registry": registry,
            "registryRevision": registry_revision,
            "registrySourceToken": registry_source_token,
            "bindings": bindings,
        }))
        .expect("reference digest")
    }

    fn streamed_scope_extension_digest(
        registry: &NarrativeSceneScopeRegistryV1,
        registry_revision: i64,
        registry_source_token: &str,
        bindings: &[Value],
    ) -> String {
        let mut stream = begin_scope_extension_digest().expect("begin digest");
        for binding in bindings {
            stream.value(binding).expect("write entry");
        }
        finish_scope_extension_digest(stream, registry, registry_revision, registry_source_token)
            .expect("finish digest")
    }

    fn binding_shaped_value(index: usize) -> Value {
        json!({
            "schemaVersion": 1,
            "projectId": "p1",
            "sceneId": format!("scene-{index:05}"),
            "sceneIncarnationId": format!("legacy:scene-{index:05}"),
            "compatibilityMarker": "unknown",
            "queryIdentity": {
                "timeline": {"kind": "unresolved", "reason": "legacy-axis-unknown"},
                "worldline": {"kind": "exact", "ref": format!("worldline:{index}")},
                "narrativeLayer": {"kind": "any"},
            },
            "materialConstraint": {
                "timeline": {"kind": "any"},
                "worldline": {"kind": "any"},
                "narrativeLayer": {"kind": "any"},
            },
            "knowledgeHolder": if index.is_multiple_of(2) {
                json!({"kind": "reader"})
            } else {
                json!({"kind": "character", "ref": format!("c{index}")})
            },
            "audience": {"kind": "reader"},
            "version": index as i64 + 1,
            "sourceToken": format!("sha256:{index:064x}"),
            "updatedAt": "2026-09-13T00:00:00.000Z",
        })
    }

    fn odd_registries() -> Vec<NarrativeSceneScopeRegistryV1> {
        vec![
            initial_registry(),
            NarrativeSceneScopeRegistryV1 {
                registry_version: NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID.to_owned(),
                timeline_refs: vec![],
                worldline_refs: vec![],
                narrative_layer_refs: vec![],
            },
            NarrativeSceneScopeRegistryV1 {
                registry_version: NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID.to_owned(),
                timeline_refs: vec!["timeline:é\u{301}".into(), "timeline:\u{1D4B3}".into()],
                worldline_refs: vec!["w\"\\\n\t\u{1}\u{7f}\u{2028}".into()],
                narrative_layer_refs: vec!["layer:\u{FF5E}".into(), "layer:\u{1F600}".into()],
            },
        ]
    }

    fn odd_entries() -> Vec<Vec<Value>> {
        let tricky = vec![
            // Escapes, controls, BMP and astral text, and keys whose UTF-16
            // order differs from their UTF-8 order.
            json!({"sceneId": "sc\"\\\n\r\t\u{8}\u{c}\u{1}\u{1f}", "status": "unavailable", "rawDigest": "sha256:ab"}),
            json!({"sceneId": "é\u{301}\u{3042}\u{FF5E}\u{1D4B3}\u{1F600}", "status": "unavailable", "rawDigest": "sha256:"}),
            json!({"\u{FF5E}": 1, "\u{1D4B3}": 2, "a": {"z": [], "\u{1F600}": null, "\u{FF5E}": {}}, "": ""}),
            // Numbers, null, booleans and nesting.
            json!([0, -1, 1, i64::MIN, i64::MAX, u64::MAX, null, true, false, [[[]], [null]], {"k": [{"k": [1, 2, {"k": null}]}]}]),
            json!(null),
            json!("plain string"),
            json!(12345),
            json!({"type": "integer", "value": -9_007_199_254_740_993_i64}),
            json!({"type": "real", "bits": format!("{:016x}", 1.5_f64.to_bits())}),
            json!({"type": "blob", "hex": hex::encode([0u8, 255, 16])}),
        ];
        vec![
            vec![],
            vec![binding_shaped_value(0)],
            (0..300).map(binding_shaped_value).collect(),
            tricky.clone(),
            tricky
                .into_iter()
                .chain((0..40).map(binding_shaped_value))
                .collect(),
        ]
    }

    #[test]
    fn the_streamed_extension_digest_equals_the_value_form_for_every_shape() {
        for (registry_index, registry) in odd_registries().iter().enumerate() {
            for revision in [0_i64, 1, 7, i64::MAX] {
                for token in ["sha256:abc", "", "t\"\u{1D4B3}\n"] {
                    for (entries_index, entries) in odd_entries().into_iter().enumerate() {
                        let reference = scope_extension_digest_reference(
                            registry,
                            revision,
                            token,
                            entries.clone(),
                        );
                        let streamed =
                            streamed_scope_extension_digest(registry, revision, token, &entries);
                        assert_eq!(
                            streamed, reference,
                            "registry {registry_index}, revision {revision}, token {token:?}, entries {entries_index}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn the_streamed_extension_digest_matches_a_pinned_value() {
        // Pinned from the Value-form oracle on the base commit, so a change on
        // either side shows up as a difference from a number this code did not
        // just compute.
        let registry = initial_registry();
        let entries = vec![binding_shaped_value(0), binding_shaped_value(1)];
        let pinned = "sha256:84709e39088bd861c89d88d4b60053d06db1f8cc09b435e32c0ebc1ce61a147e";
        assert_eq!(
            scope_extension_digest_reference(&registry, 1, "sha256:abc", entries.clone()),
            pinned
        );
        assert_eq!(
            streamed_scope_extension_digest(&registry, 1, "sha256:abc", &entries),
            pinned
        );
    }

    fn seed_many_scenes(db: &Database, scene_count: usize) {
        db.with_conn(|conn| {
            for index in 0..scene_count {
                let scene_id = format!("m{index:04}-\u{30b7}\u{30fc}\u{30f3}\u{1D4B3}");
                conn.execute(
                    "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
                     VALUES (?1, 'p1', 'scene', 'Scene', ?2)",
                    params![scene_id, format!("b{index:04}")],
                )?;
                ensure_scene_scope_binding_in_tx(
                    conn,
                    "p1",
                    &scene_id,
                    "2026-09-13T00:00:00.000Z",
                    crate::narrative_extraction::SceneScopeInit::UnknownRepairOrRestore,
                )?;
            }
            Ok(())
        })
        .expect("seed many scenes");
    }

    /// The Scene ids of `project_id` as the Scope authority takes them from
    /// the nodes it reads: every `scene` node of the project.
    fn project_scene_ids(conn: &Connection, project_id: &str) -> Result<ProjectSceneIds> {
        let ids = conn
            .prepare("SELECT id FROM tree_nodes WHERE project_id = ?1 AND node_type = 'scene'")?
            .query_map([project_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ProjectSceneIds::from_unsorted(ids.iter().map(String::as_str)))
    }

    fn assert_scope_extension_matches_the_value_form(db: &Database) -> (usize, usize) {
        db.with_read_transaction(|conn| {
            let scene_ids = project_scene_ids(conn, "p1")?;
            let ownership = SceneOwnership::Set(&scene_ids);
            let mut entries = Vec::new();
            let parts = read_scope_extension_entries(conn, "p1", true, ownership, |entry| {
                entries.push(entry);
                Ok(())
            })?;
            let unavailable = entries
                .iter()
                .filter(|entry| entry["status"] == "unavailable")
                .count();
            let reference = scope_extension_digest_reference(
                &parts.registry,
                parts.registry_revision,
                &parts.registry_source_token,
                entries.clone(),
            );
            let collected = read_scope_extension(conn, "p1", true, ownership)?;
            assert_eq!(collected.digest, reference);
            assert_eq!(collected.scene_bindings, parts.scene_bindings);
            assert_eq!(collected.scene_bindings.len(), entries.len() - unavailable);
            let uncollected = read_scope_extension(conn, "p1", false, ownership)?;
            assert_eq!(uncollected.digest, reference);
            assert!(uncollected.scene_bindings.is_empty());
            Ok((entries.len(), unavailable))
        })
        .expect("compare the streamed extension digest")
    }

    #[test]
    fn the_extension_digest_of_a_real_project_equals_the_value_form() {
        // One binding (the seeded scene).
        let db = migrated_db();
        assert_eq!(assert_scope_extension_matches_the_value_form(&db), (1, 0));

        // No binding at all.
        db.with_conn(|conn| {
            conn.execute("DELETE FROM narrative_scene_scope_bindings", [])?;
            Ok(())
        })
        .expect("remove the only binding");
        assert_eq!(assert_scope_extension_matches_the_value_form(&db), (0, 0));

        // Many bindings, in scene-id order.
        let many = migrated_db();
        seed_many_scenes(&many, 300);
        assert_eq!(
            assert_scope_extension_matches_the_value_form(&many),
            (301, 0)
        );
    }

    #[test]
    fn the_extension_digest_equals_the_value_form_with_unavailable_and_explicit_rows() {
        let db = migrated_db();
        seed_many_scenes(&db, 24);
        // An Explicit binding with Exact refs and a Character principal.
        update_narrative_scene_scope(
            &db,
            NarrativeSceneScopeUpdatePayload {
                project_id: "p1".into(),
                scene_id: "s1".into(),
                request_id: "scope-request-1".into(),
                session_id: "session-1".into(),
                event_uid: "scope-event-1".into(),
                base_version: 1,
                updated_at: "2026-09-13T00:02:00.000Z".into(),
                scope: NarrativeSceneScopeUpdateV1 {
                    schema_version: 1,
                    compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
                    query_identity: NarrativeSceneQueryIdentityV1 {
                        timeline: narrative_scene_scope::NarrativeScopeConstraintV1::Exact {
                            reference: MAIN_LINE_TIMELINE_REF.into(),
                        },
                        worldline: narrative_scene_scope::NarrativeScopeConstraintV1::Exact {
                            reference: MAIN_LINE_WORLDLINE_REF.into(),
                        },
                        narrative_layer: narrative_scene_scope::NarrativeScopeConstraintV1::Exact {
                            reference: MAIN_LINE_LAYER_REF.into(),
                        },
                    },
                    material_constraint: default_material_constraint(),
                    knowledge_holder: NarrativeScopePrincipalV1::Character {
                        reference: "c1".into(),
                    },
                    audience: NarrativeScopePrincipalV1::Character {
                        reference: "c1".into(),
                    },
                },
            },
        )
        .expect("explicit scope update");
        let before_corruption = db
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, "p1", "s1"))
            .expect("read explicit scope");
        assert_eq!(
            before_corruption.binding.compatibility_marker,
            NarrativeScopeCompatibilityMarkerV1::Explicit
        );
        let (total, unavailable) = assert_scope_extension_matches_the_value_form(&db);
        assert_eq!((total, unavailable), (25, 0));

        // Rows that fail a check become `unavailable` entries holding a digest
        // of the raw row: a broken JSON column, a wrong source token, a text
        // version, a REAL and a BLOB in text columns, a binding of a note, and
        // a binding whose Scene is missing.
        db.with_conn(|conn| {
            // The table's CHECKs and foreign keys keep a healthy database
            // from holding such rows; a damaged one can.
            conn.execute("PRAGMA foreign_keys = OFF", [])?;
            conn.execute("PRAGMA ignore_check_constraints = ON", [])?;
            let ids: Vec<String> = conn
                .prepare(
                    "SELECT scene_id FROM narrative_scene_scope_bindings
                      WHERE project_id = 'p1' AND scene_id LIKE 'm%' ORDER BY scene_id",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            conn.execute(
                "UPDATE narrative_scene_scope_bindings SET query_identity_json = 'not json'
                  WHERE scene_id = ?1",
                params![ids[0]],
            )?;
            conn.execute(
                "UPDATE narrative_scene_scope_bindings SET source_token = 'sha256:00'
                  WHERE scene_id = ?1",
                params![ids[1]],
            )?;
            conn.execute(
                "UPDATE narrative_scene_scope_bindings SET version = 'x' WHERE scene_id = ?1",
                params![ids[2]],
            )?;
            conn.execute(
                "UPDATE narrative_scene_scope_bindings SET scene_incarnation_id = 1.5
                  WHERE scene_id = ?1",
                params![ids[3]],
            )?;
            conn.execute(
                "UPDATE narrative_scene_scope_bindings SET audience_json = x'00ff10'
                  WHERE scene_id = ?1",
                params![ids[4]],
            )?;
            conn.execute(
                "UPDATE tree_nodes SET node_type = 'note' WHERE id = ?1",
                params![ids[5]],
            )?;
            conn.execute("DELETE FROM tree_nodes WHERE id = ?1", params![ids[6]])?;
            Ok(())
        })
        .expect("corrupt rows");
        let (total, unavailable) = assert_scope_extension_matches_the_value_form(&db);
        assert_eq!(total, 25);
        assert_eq!(unavailable, 7);
    }

    #[test]
    fn the_extension_entries_keep_the_base_loops_shapes_for_valid_and_broken_rows() {
        let db = migrated_db();
        seed_many_scenes(&db, 8);
        db.with_conn(|conn| {
            conn.execute("PRAGMA foreign_keys = OFF", [])?;
            conn.execute("PRAGMA ignore_check_constraints = ON", [])?;
            let ids: Vec<String> = conn
                .prepare(
                    "SELECT scene_id FROM narrative_scene_scope_bindings
                      WHERE project_id = 'p1' AND scene_id LIKE 'm%' ORDER BY scene_id",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            conn.execute("UPDATE narrative_scene_scope_bindings SET query_identity_json = 'not json' WHERE scene_id = ?1", params![ids[0]])?;
            conn.execute("UPDATE narrative_scene_scope_bindings SET source_token = 'sha256:00' WHERE scene_id = ?1", params![ids[1]])?;
            conn.execute("UPDATE narrative_scene_scope_bindings SET version = 'x' WHERE scene_id = ?1", params![ids[2]])?;
            conn.execute("UPDATE narrative_scene_scope_bindings SET scene_incarnation_id = 1.5 WHERE scene_id = ?1", params![ids[3]])?;
            conn.execute("UPDATE narrative_scene_scope_bindings SET audience_json = x'00ff10' WHERE scene_id = ?1", params![ids[4]])?;
            conn.execute("UPDATE tree_nodes SET node_type = 'note' WHERE id = ?1", params![ids[5]])?;
            conn.execute("DELETE FROM tree_nodes WHERE id = ?1", params![ids[6]])?;
            Ok(())
        })
        .expect("corrupt rows");
        let entries = db
            .with_read_transaction(|conn| {
                let scene_ids = project_scene_ids(conn, "p1")?;
                let mut entries = Vec::new();
                read_scope_extension_entries(
                    conn,
                    "p1",
                    false,
                    SceneOwnership::Set(&scene_ids),
                    |entry| {
                        entries.push(entry);
                        Ok(())
                    },
                )?;
                Ok(entries)
            })
            .expect("entries");
        // The per-row values that are generated (incarnation id, source token)
        // are read back with plain SQL; every other value, and the shape of
        // each expected entry, is written out by hand from the base loop
        // (`7edc29ba`): a binding is `serde_json::to_value(binding)`, a row
        // that fails a check is `{sceneId, status: "unavailable", rawDigest}`
        // with `rawDigest` the canonical digest of the 13-column raw row.
        let generated = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT scene_id, CAST(scene_incarnation_id AS TEXT), source_token
                       FROM narrative_scene_scope_bindings ORDER BY scene_id",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("generated values");
        assert_eq!(generated.len(), 9);
        let generated_of = |scene_id: &str| {
            generated
                .iter()
                .find(|(id, _, _)| id == scene_id)
                .map(|(_, incarnation, token)| (incarnation.clone(), token.clone()))
                .expect("scene row")
        };
        let query_identity_text = r#"{"timeline":{"kind":"unresolved","reason":"legacy-axis-unknown"},"worldline":{"kind":"unresolved","reason":"legacy-axis-unknown"},"narrativeLayer":{"kind":"unresolved","reason":"legacy-axis-unknown"}}"#;
        let material_constraint_text = r#"{"timeline":{"kind":"any"},"worldline":{"kind":"any"},"narrativeLayer":{"kind":"any"}}"#;
        let reader_text = r#"{"kind":"reader"}"#;
        let unavailable = |scene_id: &str, overrides: &[(&str, Value)], scene_owned: i64| {
            let (incarnation, token) = generated_of(scene_id);
            let mut raw = json!({
                "sceneId": {"type": "text", "value": scene_id},
                "sceneIncarnationId": {"type": "text", "value": incarnation},
                "compatibilityMarker": {"type": "text", "value": "unknown"},
                "queryIdentity": {"type": "text", "value": query_identity_text},
                "materialConstraint": {"type": "text", "value": material_constraint_text},
                "knowledgeHolder": {"type": "text", "value": reader_text},
                "version": {"type": "integer", "value": 1},
                "audience": {"type": "text", "value": reader_text},
                "sourceToken": {"type": "text", "value": token},
                "updatedAt": {"type": "text", "value": "2026-09-13T00:00:00.000Z"},
                "sceneOwned": {"type": "integer", "value": scene_owned},
                "knowledgeHolderOwned": {"type": "integer", "value": 0},
                "audienceOwned": {"type": "integer", "value": 0},
            });
            for (key, value) in overrides {
                raw[*key] = value.clone();
            }
            json!({
                "sceneId": scene_id,
                "status": "unavailable",
                "rawDigest": grimodex_core::canonical_json_digest(&raw).expect("raw digest"),
            })
        };
        let binding = |scene_id: &str| {
            let (incarnation, token) = generated_of(scene_id);
            json!({
                "schemaVersion": 1,
                "projectId": "p1",
                "sceneId": scene_id,
                "sceneIncarnationId": incarnation,
                "compatibilityMarker": "unknown",
                "queryIdentity": {
                    "timeline": {"kind": "unresolved", "reason": "legacy-axis-unknown"},
                    "worldline": {"kind": "unresolved", "reason": "legacy-axis-unknown"},
                    "narrativeLayer": {"kind": "unresolved", "reason": "legacy-axis-unknown"},
                },
                "materialConstraint": {
                    "timeline": {"kind": "any"},
                    "worldline": {"kind": "any"},
                    "narrativeLayer": {"kind": "any"},
                },
                "knowledgeHolder": {"kind": "reader"},
                "audience": {"kind": "reader"},
                "version": 1,
                "sourceToken": token,
                "updatedAt": "2026-09-13T00:00:00.000Z",
            })
        };
        let id = |index: usize| format!("m{index:04}-\u{30b7}\u{30fc}\u{30f3}\u{1D4B3}");
        let expected = vec![
            // A broken JSON column.
            unavailable(
                &id(0),
                &[(
                    "queryIdentity",
                    json!({"type": "text", "value": "not json"}),
                )],
                1,
            ),
            // A source token that does not match the state.
            unavailable(
                &id(1),
                &[("sourceToken", json!({"type": "text", "value": "sha256:00"}))],
                1,
            ),
            // A text version.
            unavailable(
                &id(2),
                &[("version", json!({"type": "text", "value": "x"}))],
                1,
            ),
            // A REAL written to a TEXT-affinity column is stored as text.
            unavailable(
                &id(3),
                &[(
                    "sceneIncarnationId",
                    json!({"type": "text", "value": "1.5"}),
                )],
                1,
            ),
            // A BLOB in a text column.
            unavailable(
                &id(4),
                &[("audience", json!({"type": "blob", "hex": "00ff10"}))],
                1,
            ),
            // A binding of a note, and one whose Scene is missing.
            unavailable(&id(5), &[], 0),
            unavailable(&id(6), &[], 0),
            // Valid rows.
            binding(&id(7)),
            binding("s1"),
        ];
        let actual = entries
            .iter()
            .map(|entry| serde_json::to_value(entry).expect("entry"))
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
    }
}

#[cfg(test)]
mod parsed_scope_control_tests {
    use super::*;
    use grimodex_core::narrative_scope_dependency_projection::ScopeDependencyIdentity;

    fn entry(
        kind: &str,
        key: &str,
    ) -> super::super::human_material_basis::MaterialSourceBasisEntry {
        super::super::human_material_basis::MaterialSourceBasisEntry {
            source_kind: kind.into(),
            source_key: key.into(),
            revision_token: "sha256:token".into(),
            revision_observed_at: None,
        }
    }

    fn identity() -> ScopeDependencyIdentity {
        ScopeDependencyIdentity {
            project_id: "p1".into(),
            run_id: "run-1".into(),
            anchor_document_ref: "document:a".into(),
            anchor_scene_ref: "scene:a".into(),
            reveal_document_ref: "document:b".into(),
            reveal_scene_ref: "scene:b".into(),
            secret: false,
        }
    }

    #[test]
    fn a_projection_control_decodes_its_identity_once_exactly_as_from_source_key() {
        let key = identity().source_key().expect("key");
        let parsed = ParsedScopeControl::parse(&entry("scope-dependency-projection-v1", &key));
        assert_eq!(parsed.identity, Some(identity()));
        assert_eq!(
            parsed.identity,
            ScopeDependencyIdentity::from_source_key(&key).ok()
        );
        assert_eq!(parsed.control.source_key, key);
    }

    #[test]
    fn an_undecodable_projection_key_has_no_identity() {
        for key in ["", "project:scope-dependency:zz", "not-a-key", "project:a"] {
            let parsed = ParsedScopeControl::parse(&entry("scope-dependency-projection-v1", key));
            assert!(parsed.identity.is_none(), "key {key:?}");
        }
        // A key that decodes but is not canonical is rejected like before.
        // Trailing whitespace is accepted by the JSON reader, so this key decodes,
        // but the re-encoded canonical form differs from it.
        let key = identity().source_key().expect("key");
        let noncanonical = format!("{key} ");
        let parsed =
            ParsedScopeControl::parse(&entry("scope-dependency-projection-v1", &noncanonical));
        assert!(parsed.identity.is_none());
    }

    #[test]
    fn other_kinds_never_carry_an_identity_even_with_a_projection_key() {
        let key = identity().source_key().expect("key");
        for kind in ["project-scope-authority", "unknown-kind", ""] {
            assert!(ParsedScopeControl::parse(&entry(kind, &key))
                .identity
                .is_none());
        }
    }

    #[test]
    fn parse_all_keeps_the_order_and_the_entries() {
        let key = identity().source_key().expect("key");
        let controls = vec![
            entry("project-scope-authority", "project:scope-authority:p1"),
            entry("scope-dependency-projection-v1", &key),
        ];
        let parsed = ParsedScopeControl::parse_all(&controls);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].control, controls[0]);
        assert_eq!(parsed[1].control, controls[1]);
        assert!(parsed[0].identity.is_none());
        assert!(parsed[1].identity.is_some());
    }

    fn authority(
    ) -> grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1 {
        use grimodex_core::narrative_project_scope_authority::{
            build_narrative_project_scope_authority_v1, NarrativeProjectScopeAuthoritySceneInputV1,
        };
        let scenes = ["a", "b", "c"]
            .into_iter()
            .map(|id| NarrativeProjectScopeAuthoritySceneInputV1 {
                scene_id: id.into(),
                raw_story_key: None,
            })
            .collect::<Vec<_>>();
        build_narrative_project_scope_authority_v1("p1", &scenes).expect("authority")
    }

    fn identity_in(
        authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
    ) -> ScopeDependencyIdentity {
        ScopeDependencyIdentity {
            anchor_scene_ref: authority.mappings[0].scene_ref.clone(),
            reveal_scene_ref: authority.mappings[1].scene_ref.clone(),
            ..identity()
        }
    }

    #[test]
    fn the_memo_answers_like_a_direct_projection_revision_comparison() {
        use grimodex_core::narrative_scope_dependency_projection::projection_revision;
        let authority = authority();
        let identity = identity_in(&authority);
        let key = identity.source_key().expect("key");
        let token = projection_revision(&identity, &authority).expect("revision");
        let mut memo = ProjectionRevisionMemo::default();
        // First call computes, later calls read the memo; both give the direct answer.
        for _ in 0..3 {
            assert!(memo.matches(&key, &identity, &authority, &token));
            assert!(!memo.matches(&key, &identity, &authority, "sha256:other"));
            assert!(!memo.matches(&key, &identity, &authority, ""));
        }
        assert_eq!(memo.answers.len(), 1);
    }

    #[test]
    fn the_memo_keeps_an_unprojectable_identity_as_no_match() {
        let authority = authority();
        let identity = ScopeDependencyIdentity {
            anchor_scene_ref: "scene:nowhere".into(),
            ..identity_in(&authority)
        };
        let key = identity.source_key().expect("key");
        let mut memo = ProjectionRevisionMemo::default();
        for _ in 0..2 {
            assert!(!memo.matches(&key, &identity, &authority, "sha256:any"));
        }
        assert_eq!(memo.answers.get(&key), Some(&None));
    }

    #[test]
    fn the_memo_separates_identities_by_their_control_key() {
        use grimodex_core::narrative_scope_dependency_projection::projection_revision;
        let authority = authority();
        let first = identity_in(&authority);
        let second = ScopeDependencyIdentity {
            reveal_scene_ref: authority.mappings[2].scene_ref.clone(),
            ..first.clone()
        };
        let (first_key, second_key) = (
            first.source_key().expect("key"),
            second.source_key().expect("key"),
        );
        let first_token = projection_revision(&first, &authority).expect("revision");
        let second_token = projection_revision(&second, &authority).expect("revision");
        assert_ne!(first_token, second_token);
        let mut memo = ProjectionRevisionMemo::default();
        assert!(memo.matches(&first_key, &first, &authority, &first_token));
        assert!(!memo.matches(&second_key, &second, &authority, &first_token));
        assert!(memo.matches(&second_key, &second, &authority, &second_token));
        assert!(memo.matches(&first_key, &first, &authority, &first_token));
        assert_eq!(memo.answers.len(), 2);
    }
}

#[cfg(test)]
#[path = "scene_scope_ownership_tests.rs"]
mod ownership_tests;

#[cfg(test)]
#[path = "scene_scope_principal_rows_tests.rs"]
mod principal_rows_tests;
