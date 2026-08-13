//! Native-owned Narrative Maintenance Change Feed (SCHEMA_VERSION 21).
//!
//! The canonical `change_events` hash chain remains the audit / Undo ledger.
//! This module stores only typed, project-scoped facts used by downstream
//! freshness and dependency invalidation. Appends require a caller-owned
//! transaction so domain mutation, Undo journal, canonical Change Event, and
//! the maintenance feed commit or roll back together.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NarrativeChangeCauseKind {
    Forward,
    Undo,
    Redo,
}

impl NarrativeChangeCauseKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Forward => "forward",
            Self::Undo => "undo",
            Self::Redo => "redo",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeChangeEventInput {
    pub object_key: Value,
    pub change_kind: String,
    pub mutation_kind: String,
    #[serde(default)]
    pub before_version: Option<i64>,
    #[serde(default)]
    pub before_digest: Option<String>,
    #[serde(default)]
    pub after_version: Option<i64>,
    #[serde(default)]
    pub after_digest: Option<String>,
    #[serde(default = "default_changed_paths")]
    pub changed_paths: Vec<String>,
    #[serde(default)]
    pub text_impact: Option<Value>,
    #[serde(default)]
    pub structural_impact: Option<Value>,
}

fn default_changed_paths() -> Vec<String> {
    vec!["/".to_string()]
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendNarrativeChangeTransactionInput {
    pub project_id: String,
    pub request_id: String,
    pub source_domain: String,
    pub source_change_event_uid: String,
    pub cause_kind: NarrativeChangeCauseKind,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub commit_id: Option<String>,
    #[serde(default)]
    pub journal_id: Option<String>,
    #[serde(default)]
    pub application_ids: Vec<String>,
    pub occurred_at: String,
    pub events: Vec<NarrativeChangeEventInput>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendNarrativeChangeTransactionResult {
    pub transaction_id: String,
    pub canonical_sequence: i64,
    pub event_ids: Vec<String>,
    pub replayed: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeChangeEventRecord {
    pub event_id: String,
    pub project_id: String,
    pub transaction_id: String,
    pub canonical_change_event_uid: String,
    pub canonical_sequence: i64,
    pub event_ordinal: i64,
    pub object_key: Value,
    pub change_kind: String,
    pub mutation_kind: String,
    pub before_version: Option<i64>,
    pub before_digest: Option<String>,
    pub after_version: Option<i64>,
    pub after_digest: Option<String>,
    pub changed_paths: Vec<String>,
    pub text_impact: Option<Value>,
    pub structural_impact: Option<Value>,
    pub cause_kind: NarrativeChangeCauseKind,
    pub original_transaction_id: Option<String>,
    pub commit_id: Option<String>,
    pub journal_id: Option<String>,
    pub application_ids: Vec<String>,
    pub occurred_at: String,
}

const CHANGE_KINDS: &[&str] = &[
    "content",
    "metadata",
    "order",
    "association",
    "catalog",
    "calendar",
    "policy",
    "schema",
    "unknown",
];
const MUTATION_KINDS: &[&str] = &["create", "update", "delete", "restore"];
const MAX_READ_LIMIT: i64 = 500;

fn require_non_empty(value: &str, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!value.trim().is_empty(), "{name} is required");
    Ok(())
}

fn canonicalize_json(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                canonicalize_json(value);
            }
        }
        Value::Object(object) => {
            let old = std::mem::take(object);
            let mut entries = old.into_iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            for (key, mut value) in entries {
                canonicalize_json(&mut value);
                object.insert(key, value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn digest_value(value: &Value) -> anyhow::Result<String> {
    let mut canonical = value.clone();
    canonicalize_json(&mut canonical);
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(&canonical)?))
    ))
}

fn payload_digest(input: &AppendNarrativeChangeTransactionInput) -> anyhow::Result<String> {
    let mut normalized = input.clone();
    normalized.application_ids.sort();
    digest_value(&serde_json::to_value(normalized)?)
}

fn validate_digest(value: Option<&str>, name: &str) -> anyhow::Result<()> {
    if let Some(value) = value {
        anyhow::ensure!(
            value.starts_with("sha256:") && value.len() > "sha256:".len(),
            "{name} must be a sha256-prefixed digest"
        );
    }
    Ok(())
}

fn validate_event(event: &NarrativeChangeEventInput) -> anyhow::Result<()> {
    let key = event
        .object_key
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("objectKey must be an object"))?;
    let kind = key
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("objectKey.kind is required"))?;
    let required_identity = match kind {
        "scene" => "sceneId",
        "chronicle-event" => "eventId",
        "codex-entry" => "entryId",
        "codex-relation" => "relationId",
        "codex-phase" => "phaseId",
        "plot-thread" => "threadId",
        "foreshadow" => "foreshadowId",
        "calendar" => "calendarRef",
        "import-source" => "sourceSetId",
        "component" => "componentId",
        other => anyhow::bail!("unsupported objectKey.kind '{other}'"),
    };
    require_non_empty(
        key.get(required_identity)
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("objectKey.{required_identity} is required"))?,
        &format!("objectKey.{required_identity}"),
    )?;
    if let Some(import_object_key) = key.get("objectKey") {
        anyhow::ensure!(
            kind == "import-source",
            "objectKey.objectKey is only valid for import-source keys"
        );
        require_non_empty(
            import_object_key
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("objectKey.objectKey must be a string"))?,
            "objectKey.objectKey",
        )?;
    }
    anyhow::ensure!(
        CHANGE_KINDS.contains(&event.change_kind.as_str()),
        "unsupported changeKind '{}'",
        event.change_kind
    );
    anyhow::ensure!(
        MUTATION_KINDS.contains(&event.mutation_kind.as_str()),
        "unsupported mutationKind '{}'",
        event.mutation_kind
    );
    let mut changed_paths = std::collections::BTreeSet::new();
    anyhow::ensure!(
        !event.changed_paths.is_empty(),
        "changedPaths must contain at least one path"
    );
    for path in &event.changed_paths {
        anyhow::ensure!(!path.trim().is_empty(), "changedPaths must be non-empty");
        anyhow::ensure!(
            changed_paths.insert(path),
            "changedPaths must not contain duplicates"
        );
    }
    if let Some(version) = event.before_version {
        anyhow::ensure!(version >= 0, "beforeVersion must not be negative");
    }
    if let Some(version) = event.after_version {
        anyhow::ensure!(version >= 0, "afterVersion must not be negative");
    }
    validate_digest(event.before_digest.as_deref(), "beforeDigest")?;
    validate_digest(event.after_digest.as_deref(), "afterDigest")?;
    let has_before = event.before_version.is_some() || event.before_digest.is_some();
    let has_after = event.after_version.is_some() || event.after_digest.is_some();
    match event.mutation_kind.as_str() {
        "create" => anyhow::ensure!(
            !has_before && has_after,
            "create events require only an after state"
        ),
        "update" => anyhow::ensure!(
            has_before && has_after,
            "update events require before and after states"
        ),
        "delete" => anyhow::ensure!(
            has_before && !has_after,
            "delete events require only a before state"
        ),
        "restore" => anyhow::ensure!(
            !has_before && has_after,
            "restore events require only an after state"
        ),
        _ => unreachable!("mutation kind was validated above"),
    }
    Ok(())
}

fn ensure_project_scoped_reference(
    conn: &Connection,
    table: &str,
    id_column: &str,
    id: &str,
    project_id: &str,
    label: &str,
) -> anyhow::Result<()> {
    // All identifiers are static literals owned by this module.
    let sql = format!("SELECT 1 FROM {table} WHERE {id_column} = ?1 AND project_id = ?2 LIMIT 1");
    let exists = conn
        .query_row(&sql, params![id, project_id], |row| row.get::<_, i64>(0))
        .optional()?
        .is_some();
    anyhow::ensure!(exists, "{label} is not in project '{project_id}'");
    Ok(())
}

fn existing_result(
    conn: &Connection,
    project_id: &str,
    source_domain: &str,
    request_id: &str,
    expected_digest: &str,
    expected_source_event_uid: &str,
) -> anyhow::Result<Option<AppendNarrativeChangeTransactionResult>> {
    let row: Option<(String, String, String, i64)> = conn
        .query_row(
            "SELECT id, payload_digest, source_change_event_uid,
                    source_change_event_sequence
               FROM narrative_change_transactions
              WHERE project_id = ?1
                AND source_domain = ?2
                AND request_id = ?3",
            params![project_id, source_domain, request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((transaction_id, digest, source_event_uid, sequence)) = row else {
        return Ok(None);
    };
    anyhow::ensure!(
        digest == expected_digest && source_event_uid == expected_source_event_uid,
        "NARRATIVE_CHANGE_FEED_IDEMPOTENCY_CONFLICT: request id reused with different payload"
    );
    let event_ids = {
        let mut statement = conn.prepare(
            "SELECT id
               FROM narrative_change_events
              WHERE project_id = ?1 AND transaction_id = ?2
              ORDER BY event_ordinal",
        )?;
        let event_ids = statement
            .query_map(params![project_id, transaction_id], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        event_ids
    };
    Ok(Some(AppendNarrativeChangeTransactionResult {
        transaction_id,
        canonical_sequence: sequence,
        event_ids,
        replayed: true,
    }))
}

/// Append a project-scoped feed transaction inside the caller's existing
/// SQLite transaction. This function never opens or commits a transaction.
pub fn append_narrative_change_transaction_in_tx(
    conn: &Connection,
    input: &AppendNarrativeChangeTransactionInput,
) -> anyhow::Result<AppendNarrativeChangeTransactionResult> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "Narrative Change Feed append requires a caller-owned transaction"
    );
    require_non_empty(&input.project_id, "projectId")?;
    require_non_empty(&input.request_id, "requestId")?;
    require_non_empty(&input.source_domain, "sourceDomain")?;
    require_non_empty(&input.source_change_event_uid, "sourceChangeEventUid")?;
    require_non_empty(&input.occurred_at, "occurredAt")?;
    anyhow::ensure!(
        !input.events.is_empty(),
        "Narrative Change Feed transaction requires at least one event"
    );
    for event in &input.events {
        validate_event(event)?;
    }

    let mut unique_application_ids = std::collections::BTreeSet::new();
    for application_id in &input.application_ids {
        require_non_empty(application_id, "applicationId")?;
        anyhow::ensure!(
            unique_application_ids.insert(application_id.as_str()),
            "applicationIds must be unique"
        );
    }

    let (canonical_sequence, canonical_operation): (i64, String) = conn
        .query_row(
            "SELECT sequence, op_type
               FROM change_events
              WHERE project_id = ?1 AND event_uid = ?2",
            params![input.project_id, input.source_change_event_uid],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "canonical Change Event '{}' is not in project '{}'",
                input.source_change_event_uid,
                input.project_id
            )
        })?;
    anyhow::ensure!(
        canonical_operation == input.source_domain,
        "canonical Change Event operation '{}' does not match sourceDomain '{}'",
        canonical_operation,
        input.source_domain
    );

    match input.cause_kind {
        NarrativeChangeCauseKind::Forward => anyhow::ensure!(
            input.original_transaction_id.is_none(),
            "forward Change Feed transaction must not name an original transaction"
        ),
        NarrativeChangeCauseKind::Undo | NarrativeChangeCauseKind::Redo => anyhow::ensure!(
            input.original_transaction_id.is_some(),
            "undo/redo Change Feed transaction requires the original transaction"
        ),
    }

    if let Some(original_transaction_id) = input.original_transaction_id.as_deref() {
        ensure_project_scoped_reference(
            conn,
            "narrative_change_transactions",
            "id",
            original_transaction_id,
            &input.project_id,
            "original transaction",
        )?;
        let (original_cause, original_commit_id, original_journal_id): (
            String,
            Option<String>,
            Option<String>,
        ) = conn.query_row(
            "SELECT cause_kind, commit_id, journal_id
               FROM narrative_change_transactions
              WHERE project_id = ?1 AND id = ?2",
            params![input.project_id, original_transaction_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        anyhow::ensure!(
            original_cause == "forward",
            "original transaction must identify the root forward mutation"
        );
        anyhow::ensure!(
            original_commit_id == input.commit_id,
            "original transaction does not belong to the named commit"
        );
        anyhow::ensure!(
            original_journal_id == input.journal_id,
            "original transaction does not belong to the named journal"
        );
    }
    if let Some(commit_id) = input.commit_id.as_deref() {
        ensure_project_scoped_reference(
            conn,
            "narrative_apply_commits",
            "id",
            commit_id,
            &input.project_id,
            "commit",
        )?;
    }
    if let Some(journal_id) = input.journal_id.as_deref() {
        ensure_project_scoped_reference(
            conn,
            "narrative_commit_journals",
            "id",
            journal_id,
            &input.project_id,
            "journal",
        )?;
    }
    if let (Some(commit_id), Some(journal_id)) =
        (input.commit_id.as_deref(), input.journal_id.as_deref())
    {
        let matches_commit = conn
            .query_row(
                "SELECT 1
                   FROM narrative_commit_journals
                  WHERE id = ?1 AND commit_id = ?2 AND project_id = ?3",
                params![journal_id, commit_id, input.project_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        anyhow::ensure!(
            matches_commit,
            "journal does not belong to the named commit"
        );
    }
    anyhow::ensure!(
        input.application_ids.is_empty() || input.commit_id.is_some(),
        "applicationIds require a commitId"
    );
    for application_id in &input.application_ids {
        let belongs_to_commit = conn
            .query_row(
                "SELECT 1
                   FROM narrative_proposal_applications a
                   INNER JOIN narrative_apply_commits c ON c.id = a.commit_id
                  WHERE a.id = ?1
                    AND c.id = ?2
                    AND c.project_id = ?3",
                params![application_id, input.commit_id, input.project_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        anyhow::ensure!(
            belongs_to_commit,
            "application '{application_id}' does not belong to the named project commit"
        );
    }

    let digest = payload_digest(input)?;
    if let Some(existing) = existing_result(
        conn,
        &input.project_id,
        &input.source_domain,
        &input.request_id,
        &digest,
        &input.source_change_event_uid,
    )? {
        return Ok(existing);
    }

    let transaction_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO narrative_change_transactions (
            id, project_id, request_id, source_domain,
            source_change_event_uid, source_change_event_sequence, cause_kind,
            original_transaction_id, commit_id, journal_id,
            application_ids_json, payload_digest, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            transaction_id,
            input.project_id,
            input.request_id,
            input.source_domain,
            input.source_change_event_uid,
            canonical_sequence,
            input.cause_kind.as_str(),
            input.original_transaction_id,
            input.commit_id,
            input.journal_id,
            serde_json::to_string(
                &unique_application_ids
                    .into_iter()
                    .map(str::to_string)
                    .collect::<Vec<_>>(),
            )?,
            digest,
            input.occurred_at,
        ],
    )?;

    let mut event_ids = Vec::with_capacity(input.events.len());
    for (ordinal, event) in input.events.iter().enumerate() {
        let event_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO narrative_change_events (
                id, project_id, transaction_id, canonical_change_event_uid,
                canonical_sequence, event_ordinal, object_key_json, change_kind,
                mutation_kind, before_version, before_digest, after_version,
                after_digest, changed_paths_json, text_impact_json,
                structural_impact_json, occurred_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                       ?13, ?14, ?15, ?16, ?17)",
            params![
                event_id,
                input.project_id,
                transaction_id,
                input.source_change_event_uid,
                canonical_sequence,
                i64::try_from(ordinal)?,
                serde_json::to_string(&event.object_key)?,
                event.change_kind,
                event.mutation_kind,
                event.before_version,
                event.before_digest,
                event.after_version,
                event.after_digest,
                serde_json::to_string(&event.changed_paths)?,
                event
                    .text_impact
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                event
                    .structural_impact
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                input.occurred_at,
            ],
        )?;
        event_ids.push(event_id);
    }

    Ok(AppendNarrativeChangeTransactionResult {
        transaction_id,
        canonical_sequence,
        event_ids,
        replayed: false,
    })
}

pub fn transaction_id_for_source_event(
    conn: &Connection,
    project_id: &str,
    change_event_uid: &str,
) -> anyhow::Result<Option<String>> {
    conn.query_row(
        "SELECT id
           FROM narrative_change_transactions
          WHERE project_id = ?1 AND source_change_event_uid = ?2",
        params![project_id, change_event_uid],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

pub fn application_ids_for_commit(
    conn: &Connection,
    project_id: &str,
    commit_id: &str,
) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT a.id
           FROM narrative_proposal_applications a
           INNER JOIN narrative_apply_commits c ON c.id = a.commit_id
          WHERE c.project_id = ?1 AND c.id = ?2
          ORDER BY a.id",
    )?;
    let application_ids = statement
        .query_map(params![project_id, commit_id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(anyhow::Error::from)?;
    Ok(application_ids)
}

fn parse_json<T: serde::de::DeserializeOwned>(raw: String, field: &str) -> anyhow::Result<T> {
    serde_json::from_str(&raw).map_err(|error| anyhow::anyhow!("invalid {field}: {error}"))
}

fn cause_from_str(value: &str) -> anyhow::Result<NarrativeChangeCauseKind> {
    match value {
        "forward" => Ok(NarrativeChangeCauseKind::Forward),
        "undo" => Ok(NarrativeChangeCauseKind::Undo),
        "redo" => Ok(NarrativeChangeCauseKind::Redo),
        other => anyhow::bail!("invalid persisted cause_kind '{other}'"),
    }
}

pub fn get_changes_since(
    conn: &Connection,
    project_id: &str,
    after_sequence: i64,
    limit: i64,
) -> anyhow::Result<Vec<NarrativeChangeEventRecord>> {
    require_non_empty(project_id, "projectId")?;
    anyhow::ensure!(after_sequence >= 0, "afterSequence must not be negative");
    anyhow::ensure!(
        (1..=MAX_READ_LIMIT).contains(&limit),
        "limit must be between 1 and {MAX_READ_LIMIT}"
    );
    let mut statement = conn.prepare(
        "SELECT e.id, e.project_id, e.transaction_id,
                e.canonical_change_event_uid, e.canonical_sequence,
                e.event_ordinal, e.object_key_json, e.change_kind,
                e.mutation_kind, e.before_version, e.before_digest,
                e.after_version, e.after_digest, e.changed_paths_json,
                e.text_impact_json, e.structural_impact_json,
                t.cause_kind, t.original_transaction_id, t.commit_id,
                t.journal_id, t.application_ids_json, e.occurred_at
           FROM narrative_change_events e
           INNER JOIN narrative_change_transactions t
             ON t.project_id = e.project_id AND t.id = e.transaction_id
          WHERE e.project_id = ?1
            AND e.canonical_sequence IN (
              SELECT page.canonical_sequence
                FROM narrative_change_events page
               WHERE page.project_id = ?1
                 AND page.canonical_sequence > ?2
               GROUP BY page.canonical_sequence
               ORDER BY page.canonical_sequence
               LIMIT ?3
            )
          ORDER BY e.canonical_sequence, e.event_ordinal, e.id
        ",
    )?;
    let rows = statement
        .query_map(params![project_id, after_sequence, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<i64>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<i64>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, String>(13)?,
                row.get::<_, Option<String>>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, String>(16)?,
                row.get::<_, Option<String>>(17)?,
                row.get::<_, Option<String>>(18)?,
                row.get::<_, Option<String>>(19)?,
                row.get::<_, String>(20)?,
                row.get::<_, String>(21)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    rows.into_iter()
        .map(
            |(
                event_id,
                project_id,
                transaction_id,
                canonical_change_event_uid,
                canonical_sequence,
                event_ordinal,
                object_key_json,
                change_kind,
                mutation_kind,
                before_version,
                before_digest,
                after_version,
                after_digest,
                changed_paths_json,
                text_impact_json,
                structural_impact_json,
                cause_kind,
                original_transaction_id,
                commit_id,
                journal_id,
                application_ids_json,
                occurred_at,
            )| {
                Ok(NarrativeChangeEventRecord {
                    event_id,
                    project_id,
                    transaction_id,
                    canonical_change_event_uid,
                    canonical_sequence,
                    event_ordinal,
                    object_key: parse_json(object_key_json, "object_key_json")?,
                    change_kind,
                    mutation_kind,
                    before_version,
                    before_digest,
                    after_version,
                    after_digest,
                    changed_paths: parse_json(changed_paths_json, "changed_paths_json")?,
                    text_impact: text_impact_json
                        .map(|raw| parse_json(raw, "text_impact_json"))
                        .transpose()?,
                    structural_impact: structural_impact_json
                        .map(|raw| parse_json(raw, "structural_impact_json"))
                        .transpose()?,
                    cause_kind: cause_from_str(&cause_kind)?,
                    original_transaction_id,
                    commit_id,
                    journal_id,
                    application_ids: parse_json(application_ids_json, "application_ids_json")?,
                    occurred_at,
                })
            },
        )
        .collect()
}

pub fn acknowledge_cursor_in_tx(
    conn: &Connection,
    project_id: &str,
    consumer_id: &str,
    through_sequence: i64,
    updated_at: &str,
) -> anyhow::Result<i64> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "Narrative Change Feed cursor update requires a caller-owned transaction"
    );
    require_non_empty(project_id, "projectId")?;
    require_non_empty(consumer_id, "consumerId")?;
    require_non_empty(updated_at, "updatedAt")?;
    anyhow::ensure!(
        through_sequence >= 0,
        "throughSequence must not be negative"
    );
    let head: i64 = conn.query_row(
        "SELECT COALESCE(MAX(canonical_sequence), 0)
           FROM narrative_change_events
          WHERE project_id = ?1",
        [project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        through_sequence <= head,
        "throughSequence {through_sequence} exceeds project feed head {head}"
    );
    conn.execute(
        "INSERT INTO narrative_change_cursors (
            project_id, consumer_id, acknowledged_through_sequence, updated_at
         ) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(project_id, consumer_id) DO UPDATE SET
            acknowledged_through_sequence = MAX(
                narrative_change_cursors.acknowledged_through_sequence,
                excluded.acknowledged_through_sequence
            ),
            updated_at = excluded.updated_at",
        params![project_id, consumer_id, through_sequence, updated_at],
    )?;
    conn.query_row(
        "SELECT acknowledged_through_sequence
           FROM narrative_change_cursors
          WHERE project_id = ?1 AND consumer_id = ?2",
        params![project_id, consumer_id],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn snapshot_digest(value: Option<&Value>) -> anyhow::Result<Option<String>> {
    value.map(digest_value).transpose()
}

fn snapshot_version(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(|snapshot| snapshot.get("version"))
        .and_then(Value::as_i64)
}

fn object_key(entity_kind: &str, entity_id: &str) -> Value {
    match entity_kind {
        "scene" => json!({ "kind": "scene", "sceneId": entity_id }),
        "event" => json!({ "kind": "chronicle-event", "eventId": entity_id }),
        "codex_entry" => json!({ "kind": "codex-entry", "entryId": entity_id }),
        "codex_relation" => json!({ "kind": "codex-relation", "relationId": entity_id }),
        "codex_phase" | "codex_entry_phase" => {
            json!({ "kind": "codex-phase", "phaseId": entity_id })
        }
        "plot_thread" => json!({ "kind": "plot-thread", "threadId": entity_id }),
        "foreshadow" => json!({ "kind": "foreshadow", "foreshadowId": entity_id }),
        other => json!({
            "kind": "component",
            "componentId": format!("{other}:{entity_id}"),
        }),
    }
}

fn change_kind(entity_kind: &str) -> &'static str {
    match entity_kind {
        "scene" => "content",
        "plot_thread_marker" | "plot_thread_branch" | "codex_relation" => "association",
        "temporal_node" | "temporal_constraint" | "temporal_projection" => "calendar",
        _ => "metadata",
    }
}

fn mutation_kind(op_kind: &str, direction: NarrativeChangeCauseKind) -> &'static str {
    match (direction, op_kind) {
        (NarrativeChangeCauseKind::Forward, "create") => "create",
        (NarrativeChangeCauseKind::Forward, "delete") => "delete",
        (NarrativeChangeCauseKind::Undo, "create") => "delete",
        (NarrativeChangeCauseKind::Undo, "delete") => "restore",
        (NarrativeChangeCauseKind::Redo, "create") => "restore",
        (NarrativeChangeCauseKind::Redo, "delete") => "delete",
        _ => "update",
    }
}

/// Convert the existing immutable commit-journal entity snapshots into typed
/// freshness events. This does not mutate persistence and never applies a fix.
pub fn events_from_journal_entities(
    entities: &[Value],
    direction: NarrativeChangeCauseKind,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    let mut events = Vec::with_capacity(entities.len());
    for entity in entities {
        let entity_kind = entity
            .get("entityKind")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("journal entity missing entityKind"))?;
        let entity_id = entity
            .get("entityId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("journal entity missing entityId"))?;
        let op_kind = entity
            .get("opKind")
            .and_then(Value::as_str)
            .unwrap_or("create");
        // `temporal.node.ensure` can be a true no-op when the semantic
        // node already exists. Keep that row in the immutable commit
        // journal for Undo/Redo OCC, but do not invent a freshness
        // mutation for it.
        if op_kind == "ensure-existing" {
            continue;
        }
        let before_snapshot = entity.get("beforeSnapshot");
        let after_snapshot = entity.get("snapshot");
        let mutation = mutation_kind(op_kind, direction);

        let (before, after) = match direction {
            NarrativeChangeCauseKind::Forward if mutation == "create" => (None, after_snapshot),
            NarrativeChangeCauseKind::Forward if mutation == "delete" => {
                (before_snapshot.or(after_snapshot), None)
            }
            NarrativeChangeCauseKind::Forward => (before_snapshot, after_snapshot),
            NarrativeChangeCauseKind::Undo if mutation == "delete" => (after_snapshot, None),
            NarrativeChangeCauseKind::Undo => (after_snapshot, before_snapshot),
            NarrativeChangeCauseKind::Redo if mutation == "restore" => (None, after_snapshot),
            NarrativeChangeCauseKind::Redo if mutation == "delete" => {
                (before_snapshot.or(after_snapshot), None)
            }
            NarrativeChangeCauseKind::Redo => (before_snapshot, after_snapshot),
        };

        events.push(NarrativeChangeEventInput {
            object_key: object_key(entity_kind, entity_id),
            change_kind: change_kind(entity_kind).to_string(),
            mutation_kind: mutation.to_string(),
            before_version: before.and_then(|before| {
                snapshot_version(Some(before))
                    .or_else(|| entity.get("version").and_then(Value::as_i64))
            }),
            before_digest: snapshot_digest(before)?,
            after_version: after.and_then(|after| {
                snapshot_version(Some(after))
                    .or_else(|| entity.get("version").and_then(Value::as_i64))
            }),
            after_digest: snapshot_digest(after)?,
            changed_paths: vec!["/".to_string()],
            text_impact: None,
            structural_impact: Some(json!({ "changedPaths": ["/"] })),
        });
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_direction_distinguishes_delete_and_restore() {
        let entities = vec![json!({
            "entityKind": "codex_entry",
            "entityId": "entry-1",
            "opKind": "create",
            "version": 1,
            "snapshot": { "id": "entry-1", "version": 1 }
        })];
        let undo = events_from_journal_entities(&entities, NarrativeChangeCauseKind::Undo).unwrap();
        let redo = events_from_journal_entities(&entities, NarrativeChangeCauseKind::Redo).unwrap();
        assert_eq!(undo[0].mutation_kind, "delete");
        assert_eq!(redo[0].mutation_kind, "restore");
    }

    #[test]
    fn invalid_object_key_is_rejected() {
        let event = NarrativeChangeEventInput {
            object_key: Value::Null,
            change_kind: "metadata".to_string(),
            mutation_kind: "update".to_string(),
            before_version: None,
            before_digest: None,
            after_version: None,
            after_digest: None,
            changed_paths: vec!["/".to_string()],
            text_impact: None,
            structural_impact: None,
        };
        assert!(validate_event(&event).is_err());
    }
}
