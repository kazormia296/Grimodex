//! Native-owned project Scene Scope default (SDEF/1,
//! `nir1-scene-scope-default-proposal/1#scope-storage-authority`, R1-R5).
//!
//! A project has zero or one default in `narrative_scope_project_defaults`.
//! It is a closed value: either `none`, or a query identity whose three axes
//! are `exact` registry members with a material constraint equal to it; the
//! holder and audience are always the reader. The default is not part of the
//! registry, of any binding, or of the project Scope authority token, and its
//! writer appends no narrative feed (R4). Its history is one canonical change
//! event per write, carrying the values before and after, the time and the
//! request identity only.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use grimodex_core::narrative_scene_scope::{
    NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
    NarrativeSceneScopeRegistryV1, NarrativeScopeConstraintV1,
};

use super::scene_scope::{
    read_registry_in_tx, MAIN_LINE_LAYER_REF, MAIN_LINE_TIMELINE_REF, MAIN_LINE_WORLDLINE_REF,
};
use super::task_leases::with_immediate_transaction;
use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::idempotency::{
    canonical_write_payload_fingerprint, insert_idempotent_response, load_idempotent_response,
    IdempotencyRequest,
};
use crate::Database;

pub const NARRATIVE_SCOPE_PROJECT_DEFAULT_CONTRACT_ID: &str =
    "narrative-scene-scope-project-default/1";
pub(crate) const SCOPE_PROJECT_DEFAULT_TABLE: &str = "narrative_scope_project_defaults";
pub(crate) const SCOPE_PROJECT_DEFAULT_OP_TYPE: &str = "scene.scope-default.update";
const SCOPE_PROJECT_DEFAULT_ENTITY_TYPE: &str = "scope_project_default";
const UPDATE_DOMAIN: &str = "narrative_scope_project_default_update";

/// The closed default value (R2). `none` carries nothing; `set` carries an
/// exact query identity and a material constraint equal to it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "state", deny_unknown_fields)]
pub enum NarrativeScopeProjectDefaultValueV1 {
    #[serde(rename = "set")]
    Set {
        #[serde(rename = "queryIdentity")]
        query_identity: NarrativeSceneQueryIdentityV1,
        #[serde(rename = "materialConstraint")]
        material_constraint: NarrativeSceneMaterialConstraintV1,
    },
    #[serde(rename = "none")]
    None {},
}

impl NarrativeScopeProjectDefaultValueV1 {
    fn state_text(&self) -> &'static str {
        match self {
            Self::Set { .. } => "set",
            Self::None {} => "none",
        }
    }

    /// The main-line default `project_create` writes for `sceneScopeDefault:
    /// "main-line"` (R12).
    pub(crate) fn main_line() -> Self {
        let exact = |reference: &str| NarrativeScopeConstraintV1::Exact {
            reference: reference.to_owned(),
        };
        Self::Set {
            query_identity: NarrativeSceneQueryIdentityV1 {
                timeline: exact(MAIN_LINE_TIMELINE_REF),
                worldline: exact(MAIN_LINE_WORLDLINE_REF),
                narrative_layer: exact(MAIN_LINE_LAYER_REF),
            },
            material_constraint: NarrativeSceneMaterialConstraintV1 {
                timeline: exact(MAIN_LINE_TIMELINE_REF),
                worldline: exact(MAIN_LINE_WORLDLINE_REF),
                narrative_layer: exact(MAIN_LINE_LAYER_REF),
            },
        }
    }
}

/// The default as a reader sees it. A project without a row reads as `none`
/// with `version` 0 and no token; the first write expects `baseVersion` 0.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeScopeProjectDefaultReadV1 {
    pub project_id: String,
    pub default: NarrativeScopeProjectDefaultValueV1,
    pub version: i64,
    pub source_token: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeScopeProjectDefaultUpdatePayload {
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    /// The `version` the caller read (0 when the project has no row yet).
    pub base_version: i64,
    pub updated_at: String,
    pub default: NarrativeScopeProjectDefaultValueV1,
}

fn table_exists(conn: &Connection) -> Result<bool> {
    // Inside the Graph C-query's and the Graph registration's pinned
    // snapshots the schema cache answers without VM steps; every other caller
    // keeps the SQL check below.
    if let Some(present) =
        crate::nir1_pinned_snapshot::table_exists(conn, SCOPE_PROJECT_DEFAULT_TABLE)?
    {
        return Ok(present);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        params![SCOPE_PROJECT_DEFAULT_TABLE],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

pub(super) fn default_source_token(
    project_id: &str,
    value: &NarrativeScopeProjectDefaultValueV1,
    version: i64,
) -> Result<String> {
    let (query_identity, material_constraint) = match value {
        NarrativeScopeProjectDefaultValueV1::Set {
            query_identity,
            material_constraint,
        } => (json!(query_identity), json!(material_constraint)),
        NarrativeScopeProjectDefaultValueV1::None {} => (Value::Null, Value::Null),
    };
    Ok(grimodex_core::canonical_json_digest(&json!({
        "contractId": NARRATIVE_SCOPE_PROJECT_DEFAULT_CONTRACT_ID,
        "projectId": project_id,
        "state": value.state_text(),
        "queryIdentity": query_identity,
        "materialConstraint": material_constraint,
        "version": version,
    }))?)
}

fn exact_reference(constraint: &NarrativeScopeConstraintV1) -> &str {
    match constraint {
        NarrativeScopeConstraintV1::Exact { reference } => reference.as_str(),
        _ => "",
    }
}

/// The exact reference of every axis, or an error when the value is not the
/// closed shape (R2): three `exact` query axes with non-empty references and a
/// material constraint equal to the query identity.
fn exact_axes(
    value: &NarrativeScopeProjectDefaultValueV1,
) -> Result<Option<[(&'static str, &str); 3]>> {
    let NarrativeScopeProjectDefaultValueV1::Set {
        query_identity,
        material_constraint,
    } = value
    else {
        return Ok(None);
    };
    let axis = |name: &'static str,
                query: &NarrativeScopeConstraintV1,
                material: &NarrativeScopeConstraintV1|
     -> Result<()> {
        let NarrativeScopeConstraintV1::Exact { reference } = query else {
            anyhow::bail!(
                "NEX_SCENE_SCOPE_DEFAULT_INVALID: the default queryIdentity.{name} must be exact"
            );
        };
        anyhow::ensure!(
            grimodex_core::contract_string::is_contract_trimmed_non_empty(reference),
            "NEX_SCENE_SCOPE_DEFAULT_INVALID: the default queryIdentity.{name} reference is empty"
        );
        anyhow::ensure!(
            material == query,
            "NEX_SCENE_SCOPE_DEFAULT_INVALID: the default materialConstraint.{name} must equal its queryIdentity"
        );
        Ok(())
    };
    axis(
        "timeline",
        &query_identity.timeline,
        &material_constraint.timeline,
    )?;
    axis(
        "worldline",
        &query_identity.worldline,
        &material_constraint.worldline,
    )?;
    axis(
        "narrativeLayer",
        &query_identity.narrative_layer,
        &material_constraint.narrative_layer,
    )?;
    let reference = exact_reference;
    Ok(Some([
        ("timeline", reference(&query_identity.timeline)),
        ("worldline", reference(&query_identity.worldline)),
        ("narrativeLayer", reference(&query_identity.narrative_layer)),
    ]))
}

/// The first axis whose reference is not a member of `registry`, if any.
fn unregistered_axis(
    axes: &[(&'static str, &str); 3],
    registry: &NarrativeSceneScopeRegistryV1,
) -> Option<&'static str> {
    axes.iter().find_map(|(name, reference)| {
        let refs = match *name {
            "timeline" => &registry.timeline_refs,
            "worldline" => &registry.worldline_refs,
            _ => &registry.narrative_layer_refs,
        };
        (!refs.iter().any(|candidate| candidate == reference)).then_some(*name)
    })
}

struct DefaultRow {
    value: NarrativeScopeProjectDefaultValueV1,
    version: i64,
    source_token: String,
    updated_at: String,
}

/// Read and fully validate this exact project's row. `Ok(None)` when the table
/// or the row is absent; an error when the row is corrupt in any way.
fn read_default_row_in_tx(conn: &Connection, project_id: &str) -> Result<Option<DefaultRow>> {
    if !table_exists(conn)? {
        return Ok(None);
    }
    type Raw = (
        i64,
        String,
        Option<String>,
        Option<String>,
        i64,
        String,
        String,
    );
    let raw: Option<Raw> = conn
        .query_row(
            "SELECT schema_version, state, query_identity_json, material_constraint_json,
                    version, source_token, updated_at
               FROM narrative_scope_project_defaults
              WHERE project_id = ?1",
            params![project_id],
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
    let Some((schema_version, state, query, material, version, source_token, updated_at)) = raw
    else {
        return Ok(None);
    };
    anyhow::ensure!(
        schema_version == 1 && version >= 1,
        "NEX_SCENE_SCOPE_DEFAULT_INVALID: unsupported scope default row"
    );
    let value = match (state.as_str(), query, material) {
        ("set", Some(query), Some(material)) => NarrativeScopeProjectDefaultValueV1::Set {
            query_identity: serde_json::from_str(&query)
                .context("NEX_SCENE_SCOPE_DEFAULT_INVALID: query identity is invalid JSON")?,
            material_constraint: serde_json::from_str(&material)
                .context("NEX_SCENE_SCOPE_DEFAULT_INVALID: material constraint is invalid JSON")?,
        },
        ("none", None, None) => NarrativeScopeProjectDefaultValueV1::None {},
        _ => anyhow::bail!("NEX_SCENE_SCOPE_DEFAULT_INVALID: scope default state is inconsistent"),
    };
    exact_axes(&value)?;
    anyhow::ensure!(
        source_token == default_source_token(project_id, &value, version)?,
        "NEX_SCENE_SCOPE_DEFAULT_INVALID: scope default source token does not match its state"
    );
    Ok(Some(DefaultRow {
        value,
        version,
        source_token,
        updated_at,
    }))
}

fn read_value(project_id: &str, row: Option<DefaultRow>) -> NarrativeScopeProjectDefaultReadV1 {
    match row {
        Some(row) => NarrativeScopeProjectDefaultReadV1 {
            project_id: project_id.to_owned(),
            default: row.value,
            version: row.version,
            source_token: Some(row.source_token),
            updated_at: Some(row.updated_at),
        },
        None => NarrativeScopeProjectDefaultReadV1 {
            project_id: project_id.to_owned(),
            default: NarrativeScopeProjectDefaultValueV1::None {},
            version: 0,
            source_token: None,
            updated_at: None,
        },
    }
}

fn ensure_project_exists(conn: &Connection, project_id: &str) -> Result<()> {
    anyhow::ensure!(
        conn.query_row(
            "SELECT 1 FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some(),
        "project '{project_id}' does not exist"
    );
    Ok(())
}

/// Read the project default (R1). A missing row reads as `none`, version 0. A
/// corrupt row is an error (`NEX_SCENE_SCOPE_DEFAULT_INVALID`).
pub fn read_narrative_scope_project_default(
    conn: &Connection,
    project_id: &str,
) -> Result<NarrativeScopeProjectDefaultReadV1> {
    anyhow::ensure!(
        !project_id.trim().is_empty(),
        "scope default projectId is required"
    );
    ensure_project_exists(conn, project_id)?;
    let row = read_default_row_in_tx(conn, project_id)?;
    Ok(read_value(project_id, row))
}

/// The default a new Scene may inherit (R7 (d), MD3): `Some` only for a valid
/// `set` row of this exact project. The caller checks registry membership
/// against the registry it read in the same transaction, and treats every
/// error here as "no default" (R8).
pub(crate) fn inheritable_project_default_in_tx(
    conn: &Connection,
    project_id: &str,
) -> Result<
    Option<(
        NarrativeSceneQueryIdentityV1,
        NarrativeSceneMaterialConstraintV1,
    )>,
> {
    Ok(match read_default_row_in_tx(conn, project_id)? {
        Some(DefaultRow {
            value:
                NarrativeScopeProjectDefaultValueV1::Set {
                    query_identity,
                    material_constraint,
                },
            ..
        }) => Some((query_identity, material_constraint)),
        _ => None,
    })
}

/// R3: refuse a registry update that removes a reference the project default
/// uses. A corrupt default row also refuses the update (fail closed).
pub(crate) fn ensure_project_default_fits_registry_in_tx(
    conn: &Connection,
    project_id: &str,
    next_registry: &NarrativeSceneScopeRegistryV1,
) -> Result<()> {
    let Some(row) = read_default_row_in_tx(conn, project_id)? else {
        return Ok(());
    };
    if let Some(axes) = exact_axes(&row.value)? {
        if let Some(axis) = unregistered_axis(&axes, next_registry) {
            anyhow::bail!(
                "NEX_SCENE_SCOPE_DEFAULT_REF_IN_USE: the project Scope default uses the {axis} reference this registry update removes"
            );
        }
    }
    Ok(())
}

struct DefaultWrite<'a> {
    project_id: &'a str,
    request_id: &'a str,
    session_id: &'a str,
    event_uid: &'a str,
    base_version: i64,
    updated_at: &'a str,
    value: &'a NarrativeScopeProjectDefaultValueV1,
}

fn history_value(row: &NarrativeScopeProjectDefaultReadV1) -> Value {
    let (query_identity, material_constraint) = match &row.default {
        NarrativeScopeProjectDefaultValueV1::Set {
            query_identity,
            material_constraint,
        } => (json!(query_identity), json!(material_constraint)),
        NarrativeScopeProjectDefaultValueV1::None {} => (Value::Null, Value::Null),
    };
    json!({
        "state": row.default.state_text(),
        "queryIdentity": query_identity,
        "materialConstraint": material_constraint,
        "version": row.version,
    })
}

fn event_timestamp(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.timestamp_millis())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis())
}

/// The one write path (MD4). It writes only the default row and one canonical
/// change event; no binding, registry, authority token or narrative feed.
fn write_default_in_tx(
    conn: &Connection,
    write: &DefaultWrite<'_>,
) -> Result<NarrativeScopeProjectDefaultReadV1> {
    ensure_project_exists(conn, write.project_id)?;
    anyhow::ensure!(
        table_exists(conn)?,
        "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scope default storage table is missing"
    );
    let current_row = read_default_row_in_tx(conn, write.project_id)?;
    let had_row = current_row.is_some();
    let current = read_value(write.project_id, current_row);
    // The history keeps the value before the write; a project without a row
    // had no default yet (null).
    let before = had_row.then(|| history_value(&current));
    anyhow::ensure!(
        current.version == write.base_version,
        "NEX_SCENE_SCOPE_DEFAULT_VERSION_MISMATCH: expected base version {}, current is {}",
        write.base_version,
        current.version
    );
    if let Some(axes) = exact_axes(write.value)? {
        let registry = read_registry_in_tx(conn, write.project_id)?;
        if let Some(axis) = unregistered_axis(&axes, &registry) {
            anyhow::bail!(
                "NEX_SCENE_SCOPE_DEFAULT_REF_UNREGISTERED: the default {axis} reference is not in this project's registry"
            );
        }
    }
    let version = write
        .base_version
        .checked_add(1)
        .context("scope default version overflow")?;
    let source_token = default_source_token(write.project_id, write.value, version)?;
    let (query_json, material_json) = match write.value {
        NarrativeScopeProjectDefaultValueV1::Set {
            query_identity,
            material_constraint,
        } => (
            Some(serde_json::to_string(query_identity)?),
            Some(serde_json::to_string(material_constraint)?),
        ),
        NarrativeScopeProjectDefaultValueV1::None {} => (None, None),
    };
    conn.execute(
        "INSERT INTO narrative_scope_project_defaults (
            project_id, schema_version, state, query_identity_json,
            material_constraint_json, version, source_token, updated_at
         ) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(project_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            state = excluded.state,
            query_identity_json = excluded.query_identity_json,
            material_constraint_json = excluded.material_constraint_json,
            version = excluded.version,
            source_token = excluded.source_token,
            updated_at = excluded.updated_at",
        params![
            write.project_id,
            write.value.state_text(),
            query_json,
            material_json,
            version,
            source_token,
            write.updated_at,
        ],
    )?;
    let after = read_value(
        write.project_id,
        read_default_row_in_tx(conn, write.project_id)?,
    );
    anyhow::ensure!(
        after.version == version && after.default == *write.value,
        "scope default row did not persist"
    );
    append_change_events_in_tx(
        conn,
        write.project_id,
        write.session_id,
        &[AppendChangeEvent {
            event_uid: write.event_uid.to_owned(),
            scene_id: None,
            domain: "narrative".to_owned(),
            op_type: SCOPE_PROJECT_DEFAULT_OP_TYPE.to_owned(),
            entity_type: Some(SCOPE_PROJECT_DEFAULT_ENTITY_TYPE.to_owned()),
            entity_id: Some(write.project_id.to_owned()),
            payload: json!({
                "requestId": write.request_id,
                "projectId": write.project_id,
                "before": before,
                "after": history_value(&after),
                "updatedAt": write.updated_at,
            })
            .to_string(),
            timestamp: event_timestamp(write.updated_at),
        }],
    )?;
    Ok(after)
}

/// The project-creation write of the main-line default (R12). Same transaction
/// as the project insert and its registry; the project has no default row yet.
pub(crate) fn write_main_line_project_default_in_tx(
    conn: &Connection,
    project_id: &str,
    request_id: &str,
    session_id: &str,
    event_uid: &str,
    updated_at: &str,
) -> Result<()> {
    write_default_in_tx(
        conn,
        &DefaultWrite {
            project_id,
            request_id,
            session_id,
            event_uid,
            base_version: 0,
            updated_at,
            value: &NarrativeScopeProjectDefaultValueV1::main_line(),
        },
    )?;
    Ok(())
}

/// Set or clear the project default with OCC and request idempotency (R3-R5,
/// MD4). The response is the default as read after the write.
pub fn update_narrative_scope_project_default(
    db: &Database,
    payload: NarrativeScopeProjectDefaultUpdatePayload,
) -> Result<Value> {
    for (value, field) in [
        (&payload.project_id, "projectId"),
        (&payload.request_id, "requestId"),
        (&payload.session_id, "sessionId"),
        (&payload.event_uid, "eventUid"),
        (&payload.updated_at, "updatedAt"),
    ] {
        anyhow::ensure!(
            !value.trim().is_empty(),
            "scope default {field} is required"
        );
    }
    anyhow::ensure!(
        payload.base_version >= 0,
        "scope default baseVersion must not be negative"
    );
    exact_axes(&payload.default)?;
    let request_hash = canonical_write_payload_fingerprint(UPDATE_DOMAIN, &payload)?;
    let idempotency = IdempotencyRequest {
        domain: UPDATE_DOMAIN,
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "NEX_SCENE_SCOPE_DEFAULT_REQUEST_CONFLICT",
    };
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |tx| {
            if let Some(response) = load_idempotent_response(tx, &idempotency)? {
                return Ok(response);
            }
            let after = write_default_in_tx(
                tx,
                &DefaultWrite {
                    project_id: &payload.project_id,
                    request_id: &payload.request_id,
                    session_id: &payload.session_id,
                    event_uid: &payload.event_uid,
                    base_version: payload.base_version,
                    updated_at: &payload.updated_at,
                    value: &payload.default,
                },
            )?;
            let response = serde_json::to_value(&after)?;
            insert_idempotent_response(tx, &idempotency, &payload.project_id, &response)?;
            Ok(response)
        })
    })
}
