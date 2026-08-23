//! D1 sealed Dependency Declaration Set persistence.
//!
//! This module is deliberately a storage boundary, not a second Freshness
//! evaluator.  V1 `narrative_dependency_edges` remains the canonical runtime
//! dependency source until a later shadow/cutover lane.  D1 only materialises
//! a complete, immutable V2 declaration set and moves its Consumer head with
//! an optimistic compare-and-swap.

use std::collections::HashSet;

use grimodex_core::narrative_dependency::{
    canonicalize_dependency_selector, compute_dependency_key, compute_dependency_set_digest,
    validate_dependency_selector, DependencyRole, DependencySelector, DependencySetDigestEntry,
    NarrativeConsumerKind, DEPENDENCY_ROLE_CONTRACT_VERSION,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::task_leases::with_immediate_transaction;
use crate::Database;

const SET_TABLE: &str = "narrative_dependency_declaration_sets";
const ENTRY_TABLE: &str = "narrative_dependency_declaration_entries";
const HEAD_TABLE: &str = "narrative_dependency_declaration_heads";

/// The only state that may cross the durable D1 boundary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DependencyDeclarationSetState {
    Sealed,
}

impl DependencyDeclarationSetState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Sealed => "sealed",
        }
    }
}

/// A typed V2 declaration.  `role` and `selector` are validated and
/// canonicalised by the native writer; callers cannot provide a digest or
/// dependency key that disagrees with them.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyDeclaration {
    pub source_object_identity: String,
    pub role: DependencyRole,
    pub selector: DependencySelector,
}

/// Input to the one-transaction D1 writer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyDeclarationSetRequest {
    pub project_id: String,
    pub consumer_kind: String,
    pub consumer_key: String,
    pub producer_id: String,
    pub producer_generation: i64,
    pub expected_head_version: i64,
    pub declarations: Vec<DependencyDeclaration>,
    pub created_at: String,
}

/// Receipt returned after the set and active head have committed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyDeclarationSetReceipt {
    pub declaration_set_id: String,
    pub state: DependencyDeclarationSetState,
    pub dependency_set_digest: String,
    pub producer_id: String,
    pub producer_generation: i64,
    pub head_version: i64,
}

/// A stored declaration entry returned by the active-head read path.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDependencyDeclaration {
    pub id: String,
    pub declaration_set_id: String,
    pub source_object_identity: String,
    pub dependency_key: String,
    pub dependency_role: DependencyRole,
    pub role_contract_version: String,
    pub selector_json: String,
    pub selector_digest: String,
}

/// A verified sealed set selected by an active Consumer head.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDependencyDeclarationSet {
    pub declaration_set_id: String,
    pub project_id: String,
    pub consumer_kind: String,
    pub consumer_key: String,
    pub producer_id: String,
    pub producer_generation: i64,
    pub dependency_set_digest: String,
    pub state: DependencyDeclarationSetState,
    pub entries: Vec<StoredDependencyDeclaration>,
}

#[derive(Clone, Debug)]
struct PreparedDeclaration {
    source_object_identity: String,
    dependency_key: String,
    dependency_role: DependencyRole,
    role_contract_version: String,
    selector_json: String,
    selector_digest: String,
}

#[derive(Clone, Debug)]
struct DeclarationSetRow {
    id: String,
    project_id: String,
    consumer_kind: String,
    consumer_key: String,
    producer_id: String,
    producer_generation: i64,
    dependency_set_digest: String,
    state: String,
}

#[derive(Clone, Debug)]
struct DeclarationHeadRow {
    active_declaration_set_id: String,
    producer_id: String,
    producer_generation: i64,
    version: i64,
}

/// Persist a complete V2 declaration set and publish its head atomically.
///
/// Validation happens before any DML.  The set row, every entry, and the head
/// CAS share one `BEGIN IMMEDIATE`; a conflict or constraint failure rolls all
/// of them back.  An exact replay of the already-active producer generation
/// returns the existing receipt without inserting another set.
pub fn write_dependency_declaration_set(
    db: &Database,
    request: DependencyDeclarationSetRequest,
) -> anyhow::Result<DependencyDeclarationSetReceipt> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            write_dependency_declaration_set_in_tx(conn, request)
        })
    })
}

/// Transaction-composable form for future C2A/C2B writers.  The caller owns
/// the surrounding transaction when it needs to bind this write to another
/// immutable revision.
pub fn write_dependency_declaration_set_in_tx(
    conn: &Connection,
    request: DependencyDeclarationSetRequest,
) -> anyhow::Result<DependencyDeclarationSetReceipt> {
    let prepared = prepare_request(&request)?;
    let digest_entries = prepared
        .iter()
        .map(|entry| DependencySetDigestEntry {
            source_object_identity: entry.source_object_identity.clone(),
            dependency_key: entry.dependency_key.clone(),
            selector_digest: entry.selector_digest.clone(),
        })
        .collect::<Vec<_>>();
    let dependency_set_digest = compute_dependency_set_digest(&digest_entries)
        .map_err(|error| anyhow::anyhow!("NEX_DECLARATION_DIGEST_INVALID: {error}"))?;

    let current_head = load_head(
        conn,
        &request.project_id,
        &request.consumer_kind,
        &request.consumer_key,
    )?;

    if let Some(head) = &current_head {
        // Replays are safe only when they identify the exact currently active
        // generation and the active set still verifies end-to-end.  A stale
        // expected version alone never authorises a new write.
        if head.producer_generation == request.producer_generation
            && head.producer_id == request.producer_id
        {
            if let Some(existing) = load_verified_set_by_id(
                conn,
                &head.active_declaration_set_id,
                Some((
                    &request.project_id,
                    &request.consumer_kind,
                    &request.consumer_key,
                )),
            )? {
                if existing.dependency_set_digest == dependency_set_digest {
                    return Ok(DependencyDeclarationSetReceipt {
                        declaration_set_id: existing.declaration_set_id,
                        state: DependencyDeclarationSetState::Sealed,
                        dependency_set_digest: existing.dependency_set_digest,
                        producer_id: head.producer_id.clone(),
                        producer_generation: head.producer_generation,
                        head_version: head.version,
                    });
                }
            }
        }

        anyhow::ensure!(
            request.producer_generation > head.producer_generation,
            "NEX_DECLARATION_GENERATION_CONFLICT: incoming producer generation {} must be greater than current {}",
            request.producer_generation,
            head.producer_generation
        );
        anyhow::ensure!(
            request.expected_head_version == head.version,
            "NEX_DECLARATION_HEAD_VERSION_CONFLICT: expected version {}, current {}",
            request.expected_head_version,
            head.version
        );
    } else {
        anyhow::ensure!(
            request.expected_head_version == 0,
            "NEX_DECLARATION_HEAD_VERSION_CONFLICT: expected version {} for a missing head, current 0",
            request.expected_head_version
        );
    }

    let declaration_set_id = Uuid::new_v4().to_string();
    conn.execute(
        &format!(
            "INSERT INTO {SET_TABLE}
                (id, project_id, consumer_kind, consumer_key, producer_id,
                 producer_generation, dependency_set_digest, state, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'sealed', ?8)"
        ),
        params![
            declaration_set_id,
            request.project_id,
            request.consumer_kind,
            request.consumer_key,
            request.producer_id,
            request.producer_generation,
            dependency_set_digest,
            request.created_at,
        ],
    )?;

    for declaration in &prepared {
        conn.execute(
            &format!(
                "INSERT INTO {ENTRY_TABLE}
                    (id, declaration_set_id, source_object_identity, dependency_key,
                     dependency_role, role_contract_version, selector_json,
                     selector_digest, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
            ),
            params![
                Uuid::new_v4().to_string(),
                declaration_set_id,
                declaration.source_object_identity,
                declaration.dependency_key,
                declaration.dependency_role.as_str(),
                declaration.role_contract_version,
                declaration.selector_json,
                declaration.selector_digest,
                request.created_at,
            ],
        )?;
    }

    let next_version = current_head.as_ref().map_or(Ok(1_i64), |head| {
        head.version.checked_add(1).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_DECLARATION_HEAD_VERSION_OVERFLOW: current head version is too large"
            )
        })
    })?;
    if current_head.is_some() {
        let changed = conn.execute(
            &format!(
                "UPDATE {HEAD_TABLE}
                    SET active_declaration_set_id = ?1,
                        producer_id = ?2,
                        producer_generation = ?3,
                        version = ?4,
                        updated_at = ?5
                  WHERE project_id = ?6
                    AND consumer_kind = ?7
                    AND consumer_key = ?8
                    AND version = ?9
                    AND producer_generation < ?3"
            ),
            params![
                declaration_set_id,
                request.producer_id,
                request.producer_generation,
                next_version,
                request.created_at,
                request.project_id,
                request.consumer_kind,
                request.consumer_key,
                request.expected_head_version,
            ],
        )?;
        anyhow::ensure!(
            changed == 1,
            "NEX_DECLARATION_HEAD_CAS_FAILED: declaration head changed before update"
        );
    } else {
        conn.execute(
            &format!(
                "INSERT INTO {HEAD_TABLE}
                    (project_id, consumer_kind, consumer_key,
                     active_declaration_set_id, producer_id, producer_generation,
                     version, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
            ),
            params![
                request.project_id,
                request.consumer_kind,
                request.consumer_key,
                declaration_set_id,
                request.producer_id,
                request.producer_generation,
                next_version,
                request.created_at,
            ],
        )?;
    }

    Ok(DependencyDeclarationSetReceipt {
        declaration_set_id,
        state: DependencyDeclarationSetState::Sealed,
        dependency_set_digest,
        producer_id: request.producer_id,
        producer_generation: request.producer_generation,
        head_version: next_version,
    })
}

/// Read only the V2 set selected by a sealed, internally consistent head.
/// `None` means no active V2 head exists or the V2 rows are incomplete/corrupt;
/// callers must retain V1 as their canonical fallback in either case.
pub fn read_active_dependency_declaration_set(
    db: &Database,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
) -> anyhow::Result<Option<ActiveDependencyDeclarationSet>> {
    db.with_conn(|conn| {
        if !table_exists(conn, SET_TABLE)?
            || !table_exists(conn, ENTRY_TABLE)?
            || !table_exists(conn, HEAD_TABLE)?
        {
            return Ok(None);
        }
        let Some(head) = load_head(conn, project_id, consumer_kind, consumer_key)? else {
            return Ok(None);
        };
        load_verified_set_by_id(
            conn,
            &head.active_declaration_set_id,
            Some((project_id, consumer_kind, consumer_key)),
        )
    })
}

/// Verify all D1 rows without making V2 the runtime authority.  A malformed
/// set/head/entry returns `Ok(false)` so a caller can fail closed and retain
/// V1; missing D1 tables are also reported as false rather than being treated
/// as a valid empty V2 graph.
pub fn verify_dependency_declaration_storage(db: &Database) -> anyhow::Result<bool> {
    db.with_conn(verify_dependency_declaration_storage_in_conn)
}

fn prepare_request(
    request: &DependencyDeclarationSetRequest,
) -> anyhow::Result<Vec<PreparedDeclaration>> {
    ensure_non_empty("projectId", &request.project_id)?;
    ensure_non_empty("consumerKind", &request.consumer_kind)?;
    ensure_non_empty("consumerKey", &request.consumer_key)?;
    ensure_non_empty("producerId", &request.producer_id)?;
    ensure_non_empty("createdAt", &request.created_at)?;
    validate_canonical_instant("createdAt", &request.created_at)?;
    anyhow::ensure!(
        request.producer_generation >= 0,
        "NEX_DECLARATION_GENERATION_INVALID: producer generation must be non-negative"
    );
    anyhow::ensure!(
        request.expected_head_version >= 0,
        "NEX_DECLARATION_HEAD_VERSION_INVALID: expected head version must be non-negative"
    );
    NarrativeConsumerKind::try_from(request.consumer_kind.as_str())
        .map_err(|error| anyhow::anyhow!("NEX_DECLARATION_CONSUMER_INVALID: {error}"))?;

    let mut seen = HashSet::new();
    request
        .declarations
        .iter()
        .map(|declaration| {
            ensure_non_empty("sourceObjectIdentity", &declaration.source_object_identity)?;
            validate_dependency_selector(&declaration.selector, None)
                .map_err(|error| anyhow::anyhow!("NEX_DECLARATION_SELECTOR_INVALID: {error}"))?;
            let selector_json = canonicalize_dependency_selector(&declaration.selector)
                .map_err(|error| anyhow::anyhow!("NEX_DECLARATION_SELECTOR_INVALID: {error}"))?;
            let selector_digest = digest_string(&selector_json);
            let dependency_key =
                compute_dependency_key(declaration.role.as_str(), &declaration.selector)
                    .map_err(|error| anyhow::anyhow!("NEX_DECLARATION_KEY_INVALID: {error}"))?;
            anyhow::ensure!(
                seen.insert((
                    declaration.source_object_identity.clone(),
                    dependency_key.clone()
                )),
                "NEX_DECLARATION_DUPLICATE: source and dependency key are repeated"
            );
            Ok(PreparedDeclaration {
                source_object_identity: declaration.source_object_identity.clone(),
                dependency_key,
                dependency_role: declaration.role,
                role_contract_version: DEPENDENCY_ROLE_CONTRACT_VERSION.to_owned(),
                selector_json,
                selector_digest,
            })
        })
        .collect()
}

fn ensure_non_empty(name: &str, value: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !value.trim().is_empty() && value.trim() == value,
        "NEX_DECLARATION_INPUT_INVALID: {name} must be non-empty and trimmed"
    );
    Ok(())
}

/// D1 timestamps use the same canonical instant contract as Web Editor
/// handoffs: RFC3339, UTC (`Z` or an equivalent zero offset), and exactly
/// millisecond precision.  Keeping the caller-supplied value canonical makes
/// replay and digest-adjacent audit data deterministic instead of allowing
/// multiple spellings of the same instant into the sealed rows.
fn validate_canonical_instant(name: &str, value: &str) -> anyhow::Result<()> {
    let parsed = chrono::DateTime::parse_from_rfc3339(value).map_err(|_| {
        anyhow::anyhow!("NEX_DECLARATION_TIMESTAMP_INVALID: {name} must be canonical RFC3339")
    })?;
    anyhow::ensure!(
        parsed.offset().local_minus_utc() == 0
            && parsed.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) == value,
        "NEX_DECLARATION_TIMESTAMP_INVALID: {name} must be UTC RFC3339 with millisecond precision"
    );
    Ok(())
}

fn is_trimmed_non_empty(value: &str) -> bool {
    !value.trim().is_empty() && value.trim() == value
}

fn digest_string(value: &str) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(value.as_bytes())))
}

fn load_head(
    conn: &Connection,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
) -> anyhow::Result<Option<DeclarationHeadRow>> {
    conn.query_row(
        &format!(
            "SELECT active_declaration_set_id, producer_id, producer_generation, version
               FROM {HEAD_TABLE}
              WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3"
        ),
        params![project_id, consumer_kind, consumer_key],
        |row| {
            Ok(DeclarationHeadRow {
                active_declaration_set_id: row.get(0)?,
                producer_id: row.get(1)?,
                producer_generation: row.get(2)?,
                version: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn load_set_row(conn: &Connection, set_id: &str) -> anyhow::Result<Option<DeclarationSetRow>> {
    conn.query_row(
        &format!(
            "SELECT id, project_id, consumer_kind, consumer_key, producer_id,
                    producer_generation, dependency_set_digest, state
               FROM {SET_TABLE}
              WHERE id = ?1"
        ),
        [set_id],
        |row| row_to_set(row),
    )
    .optional()
    .map_err(Into::into)
}

fn row_to_set(row: &Row<'_>) -> rusqlite::Result<DeclarationSetRow> {
    Ok(DeclarationSetRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        consumer_kind: row.get(2)?,
        consumer_key: row.get(3)?,
        producer_id: row.get(4)?,
        producer_generation: row.get(5)?,
        dependency_set_digest: row.get(6)?,
        state: row.get(7)?,
    })
}

fn load_verified_set_by_id(
    conn: &Connection,
    set_id: &str,
    expected_consumer: Option<(&str, &str, &str)>,
) -> anyhow::Result<Option<ActiveDependencyDeclarationSet>> {
    let Some(set) = load_set_row(conn, set_id)? else {
        return Ok(None);
    };
    if set.state != DependencyDeclarationSetState::Sealed.as_str()
        || !is_digest(&set.dependency_set_digest)
        || set.producer_generation < 0
        || !is_trimmed_non_empty(&set.project_id)
        || !is_trimmed_non_empty(&set.consumer_kind)
        || !is_trimmed_non_empty(&set.consumer_key)
        || !is_trimmed_non_empty(&set.producer_id)
        || expected_consumer.is_some_and(|(project, kind, key)| {
            set.project_id != project || set.consumer_kind != kind || set.consumer_key != key
        })
    {
        return Ok(None);
    }
    if NarrativeConsumerKind::try_from(set.consumer_kind.as_str()).is_err() {
        return Ok(None);
    }

    let mut statement = conn.prepare(&format!(
        "SELECT id, declaration_set_id, source_object_identity, dependency_key,
                dependency_role, role_contract_version, selector_json, selector_digest
           FROM {ENTRY_TABLE}
          WHERE declaration_set_id = ?1
          ORDER BY id"
    ))?;
    let raw_entries = statement
        .query_map([set.id.as_str()], row_to_entry)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if raw_entries.iter().any(Option::is_none) {
        return Ok(None);
    }
    let entries = raw_entries.into_iter().flatten().collect::<Vec<_>>();

    let mut digest_entries = Vec::with_capacity(entries.len());
    let mut seen = HashSet::new();
    for entry in &entries {
        if entry.declaration_set_id != set.id
            || entry.role_contract_version != DEPENDENCY_ROLE_CONTRACT_VERSION
            || !is_trimmed_non_empty(&entry.source_object_identity)
            || !is_digest(&entry.dependency_key)
            || !is_digest(&entry.selector_digest)
            || !seen.insert((
                entry.source_object_identity.clone(),
                entry.dependency_key.clone(),
            ))
        {
            return Ok(None);
        }
        let selector_value: serde_json::Value = match serde_json::from_str(&entry.selector_json) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        let selector = match grimodex_core::narrative_dependency::validate_dependency_selector_value(
            &selector_value,
            None,
        ) {
            Ok(selector) => selector,
            Err(_) => return Ok(None),
        };
        let canonical_selector = match canonicalize_dependency_selector(&selector) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        if canonical_selector != entry.selector_json
            || digest_string(&canonical_selector) != entry.selector_digest
            || compute_dependency_key(entry.dependency_role.as_str(), &selector).ok()
                != Some(entry.dependency_key.clone())
        {
            return Ok(None);
        }
        digest_entries.push(DependencySetDigestEntry {
            source_object_identity: entry.source_object_identity.clone(),
            dependency_key: entry.dependency_key.clone(),
            selector_digest: entry.selector_digest.clone(),
        });
    }
    let Ok(computed_digest) = compute_dependency_set_digest(&digest_entries) else {
        return Ok(None);
    };
    if computed_digest != set.dependency_set_digest {
        return Ok(None);
    }

    Ok(Some(ActiveDependencyDeclarationSet {
        declaration_set_id: set.id,
        project_id: set.project_id,
        consumer_kind: set.consumer_kind,
        consumer_key: set.consumer_key,
        producer_id: set.producer_id,
        producer_generation: set.producer_generation,
        dependency_set_digest: set.dependency_set_digest,
        state: DependencyDeclarationSetState::Sealed,
        entries,
    }))
}

fn row_to_entry(row: &Row<'_>) -> rusqlite::Result<Option<StoredDependencyDeclaration>> {
    let role: String = row.get(4)?;
    let Ok(dependency_role) = DependencyRole::try_from(role.as_str()) else {
        // An unknown role is persisted corruption, not a storage-layer query
        // failure.  Keep the public verifier fail-closed by treating the
        // active V2 set as unavailable.
        return Ok(None);
    };
    Ok(Some(StoredDependencyDeclaration {
        id: row.get(0)?,
        declaration_set_id: row.get(1)?,
        source_object_identity: row.get(2)?,
        dependency_key: row.get(3)?,
        dependency_role,
        role_contract_version: row.get(5)?,
        selector_json: row.get(6)?,
        selector_digest: row.get(7)?,
    }))
}

fn is_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn table_exists(conn: &Connection, table: &str) -> anyhow::Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
         )",
        [table],
        |row| row.get(0),
    )?)
}

fn verify_dependency_declaration_storage_in_conn(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, SET_TABLE)?
        || !table_exists(conn, ENTRY_TABLE)?
        || !table_exists(conn, HEAD_TABLE)?
    {
        return Ok(false);
    }

    let invalid_set: bool = conn.query_row(
        &format!(
            "SELECT EXISTS(
                SELECT 1 FROM {SET_TABLE}
                 WHERE state <> 'sealed'
                    OR trim(project_id) = '' OR trim(consumer_kind) = ''
                    OR trim(consumer_key) = '' OR trim(producer_id) = ''
                    OR producer_generation < 0
                    OR dependency_set_digest NOT GLOB 'sha256:*'
                    OR length(dependency_set_digest) <> 71
            )"
        ),
        [],
        |row| row.get(0),
    )?;
    if invalid_set {
        return Ok(false);
    }

    let orphan_entries: bool = conn.query_row(
        &format!(
            "SELECT EXISTS(
                SELECT 1 FROM {ENTRY_TABLE} AS entry
                 LEFT JOIN {SET_TABLE} AS set_row
                   ON set_row.id = entry.declaration_set_id
                WHERE set_row.id IS NULL OR set_row.state <> 'sealed'
                   OR trim(entry.source_object_identity) = ''
                   OR entry.role_contract_version <> ?1
                   OR entry.dependency_key NOT GLOB 'sha256:*'
                   OR length(entry.dependency_key) <> 71
                   OR entry.selector_digest NOT GLOB 'sha256:*'
                   OR length(entry.selector_digest) <> 71
                   OR json_valid(entry.selector_json) = 0
            )"
        ),
        [DEPENDENCY_ROLE_CONTRACT_VERSION],
        |row| row.get(0),
    )?;
    if orphan_entries {
        return Ok(false);
    }

    let invalid_heads: bool = conn.query_row(
        &format!(
            "SELECT EXISTS(
                SELECT 1 FROM {HEAD_TABLE} AS head
                 LEFT JOIN {SET_TABLE} AS set_row
                   ON set_row.id = head.active_declaration_set_id
                WHERE set_row.id IS NULL OR set_row.state <> 'sealed'
                   OR set_row.project_id <> head.project_id
                   OR set_row.consumer_kind <> head.consumer_kind
                   OR set_row.consumer_key <> head.consumer_key
                   OR set_row.producer_id <> head.producer_id
                   OR set_row.producer_generation <> head.producer_generation
                   OR head.producer_generation < 0 OR head.version < 1
            )"
        ),
        [],
        |row| row.get(0),
    )?;
    if invalid_heads {
        return Ok(false);
    }

    let mut statement = conn.prepare(&format!(
        "SELECT id, project_id, consumer_kind, consumer_key
           FROM {SET_TABLE}"
    ))?;
    let sets = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, project_id, consumer_kind, consumer_key) in sets {
        if load_verified_set_by_id(
            conn,
            &id,
            Some((&project_id, &consumer_kind, &consumer_key)),
        )?
        .is_none()
        {
            return Ok(false);
        }
    }
    Ok(true)
}
