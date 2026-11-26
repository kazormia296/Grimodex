use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    agent_writes::{
        validate_renderer_authority_context_for_routes, RendererCanonicalWriteContext,
    },
    change_events::{
        without_renderer_authority_context, AppendChangeEvent,
    },
    idempotency::{load_row, payload_fingerprint, run_atomic_create, IdempotencyRequest},
    narrative_extraction::change_feed::{
        append_canonical_and_narrative_change_in_tx, AppendNarrativeChangeTransactionInput,
        NarrativeChangeCauseKind, NarrativeChangeEventInput, NarrativeChangeOrigin,
    },
    Database,
};

const RULE_REVISIONS: &str = "identity_correction_rule_revisions";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleRevisionWriteContext {
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleRevisionFields {
    pub kind: String,
    pub scope_kind: String,
    pub scope_scene_id: Option<String>,
    pub surface_text: Option<String>,
    pub entry_id: Option<String>,
    pub other_entry_id: Option<String>,
    pub canonical_name: Option<String>,
    pub keep_previous_as_alias: Option<bool>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleRevisionPayload {
    pub project_id: String,
    pub fields: RuleRevisionFields,
    pub context: RuleRevisionWriteContext,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetireRuleRevisionPayload {
    pub project_id: String,
    pub previous_revision_id: String,
    pub context: RuleRevisionWriteContext,
}

enum RevisionMode {
    Create(RuleRevisionFields),
    Supersede {
        previous_revision_id: String,
        fields: RuleRevisionFields,
    },
    Retire { previous_revision_id: String },
}

impl RevisionMode {
    fn action(&self) -> &'static str {
        match self {
            Self::Create(_) => "create",
            Self::Supersede { .. } => "supersede",
            Self::Retire { .. } => "retire",
        }
    }

    fn previous_revision_id(&self) -> Option<&str> {
        match self {
            Self::Create(_) => None,
            Self::Supersede {
                previous_revision_id,
                ..
            }
            | Self::Retire {
                previous_revision_id,
            } => Some(previous_revision_id),
        }
    }

    fn fields(&self) -> Option<&RuleRevisionFields> {
        match self {
            Self::Create(fields) | Self::Supersede { fields, .. } => Some(fields),
            Self::Retire { .. } => None,
        }
    }

    fn normalize_pair_order(&mut self) -> anyhow::Result<()> {
        let fields = match self {
            Self::Create(fields) | Self::Supersede { fields, .. } => fields,
            Self::Retire { .. } => return Ok(()),
        };
        fields.normalize_pair_order()
    }
}

pub fn create_rule_revision(
    db: &Database,
    payload: RuleRevisionPayload,
    authority: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    write_rule_revision(
        db,
        payload.project_id,
        payload.context,
        RevisionMode::Create(payload.fields),
        authority,
    )
}

pub fn supersede_rule_revision(
    db: &Database,
    previous_revision_id: &str,
    payload: RuleRevisionPayload,
    authority: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    write_rule_revision(
        db,
        payload.project_id,
        payload.context,
        RevisionMode::Supersede {
            previous_revision_id: previous_revision_id.to_string(),
            fields: payload.fields,
        },
        authority,
    )
}

pub fn retire_rule_revision(
    db: &Database,
    payload: RetireRuleRevisionPayload,
    authority: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    write_rule_revision(
        db,
        payload.project_id,
        payload.context,
        RevisionMode::Retire {
            previous_revision_id: payload.previous_revision_id,
        },
        authority,
    )
}

fn write_rule_revision(
    db: &Database,
    project_id: String,
    context: RuleRevisionWriteContext,
    mut mode: RevisionMode,
    authority: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    validate_renderer_authority_context_for_routes(&authority, &["human-direct"])?;
    anyhow::ensure!(
        !context.session_id.trim().is_empty(),
        "identity correction sessionId must be non-empty"
    );
    mode.normalize_pair_order()?;

    let request_id = authority.request_id.clone();
    let revision_id = format!(
        "identity-rule-revision-{}",
        payload_fingerprint(
            "identity-correction-rule-revision-id",
            &json!({"projectId": project_id, "requestId": request_id}),
        )?
    );
    let payload_hash = payload_fingerprint(
        "identity-correction-rule-revision",
        &json!({
            "action": mode.action(),
            "projectId": project_id.clone(),
            "previousRevisionId": mode.previous_revision_id(),
            "fields": mode.fields(),
            "actorId": authority.caller.clone(),
        }),
    )?;
    let load_revision_id = revision_id.clone();
    let create_revision_id = revision_id.clone();
    let event_uid = authority.event_uid.clone();
    let actor_id = authority.caller.clone();
    let origin = authority.origin;
    let original_transaction_id = authority.original_transaction_id.clone();
    let undo_journal_id = authority.undo_journal_id.clone();
    let session_id = context.session_id;
    let idempotency_request_id = request_id.clone();
    let insert_request_id = request_id.clone();
    let outcome = run_atomic_create(
        db,
        IdempotencyRequest {
            domain: "identity_correction_rule_revision",
            request_id: Some(idempotency_request_id.as_str()),
            payload_hash: &payload_hash,
            conflict_marker: "IDENTITY_CORRECTION_RULE_REVISION_IDEMPOTENCY_CONFLICT",
        },
        move |conn| {
            ensure_project_exists(conn, &project_id)?;
            let (rule_id, revision_no, supersedes_revision_id, mut fields, state) = match mode {
                RevisionMode::Create(fields) => {
                    let rule_id = format!(
                        "identity-rule-{}",
                        payload_fingerprint(
                            "identity-correction-rule-id",
                            &create_revision_id,
                        )?
                    );
                    (rule_id, 1_i64, None, fields, "active")
                }
                RevisionMode::Supersede {
                    previous_revision_id,
                    fields,
                } => {
                    let previous = require_current_revision(
                        conn,
                        &project_id,
                        &previous_revision_id,
                    )?;
                    let rule_id = string_column(&previous, "rule_id")?;
                    let revision_no = integer_column(&previous, "revision_no")?
                        .checked_add(1)
                        .ok_or_else(|| anyhow::anyhow!("rule revision number overflow"))?;
                    (
                        rule_id,
                        revision_no,
                        Some(previous_revision_id),
                        fields,
                        "active",
                    )
                }
                RevisionMode::Retire {
                    previous_revision_id,
                } => {
                    let previous = require_current_revision(
                        conn,
                        &project_id,
                        &previous_revision_id,
                    )?;
                    let rule_id = string_column(&previous, "rule_id")?;
                    let revision_no = integer_column(&previous, "revision_no")?
                        .checked_add(1)
                        .ok_or_else(|| anyhow::anyhow!("rule revision number overflow"))?;
                    (
                        rule_id,
                        revision_no,
                        Some(previous_revision_id),
                        fields_from_row(&previous)?,
                        "retired",
                    )
                }
            };
            fields.validate_and_normalize(conn, &project_id)?;

            let now = Utc::now();
            let created_at = now.to_rfc3339();
            conn.execute(
                "INSERT INTO identity_correction_rule_revisions
                    (id, project_id, rule_id, revision_no, supersedes_revision_id, state,
                     kind, scope_kind, scope_scene_id, surface_text, entry_id, other_entry_id,
                     canonical_name, keep_previous_as_alias, reason, provenance_kind,
                     provenance_ref, actor_id, created_at, request_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                         ?13, ?14, ?15, 'manual', ?16, ?17, ?18, ?19)",
                params![
                    create_revision_id,
                    project_id,
                    rule_id,
                    revision_no,
                    supersedes_revision_id,
                    state,
                    fields.kind,
                    fields.scope_kind,
                    fields.scope_scene_id,
                    fields.surface_text,
                    fields.entry_id,
                    fields.other_entry_id,
                    fields.canonical_name,
                    fields.keep_previous_as_alias.map(i64::from),
                    fields.reason,
                    insert_request_id,
                    actor_id,
                    created_at,
                    insert_request_id,
                ],
            )?;

            let canonical_event = AppendChangeEvent {
                event_uid: event_uid.clone(),
                scene_id: None,
                domain: "identity-correction".to_string(),
                op_type: "rule.revise".to_string(),
                entity_type: Some("identity_correction_rule".to_string()),
                entity_id: Some(create_revision_id.clone()),
                payload: json!({
                    "ruleRevisionId": create_revision_id,
                    "ruleId": rule_id,
                    "kind": fields.kind,
                })
                .to_string(),
                timestamp: now.timestamp_millis(),
            };
            let cause_kind = match origin {
                NarrativeChangeOrigin::Undo => NarrativeChangeCauseKind::Undo,
                NarrativeChangeOrigin::Redo => NarrativeChangeCauseKind::Redo,
                _ => NarrativeChangeCauseKind::Forward,
            };
            let narrative_input = AppendNarrativeChangeTransactionInput {
                project_id: project_id.clone(),
                request_id: request_id.clone(),
                source_domain: "rule.revise".to_string(),
                source_change_event_uid: event_uid,
                cause_kind,
                origin,
                original_transaction_id,
                commit_id: None,
                journal_id: None,
                undo_journal_id,
                application_ids: Vec::new(),
                occurred_at: created_at,
                events: vec![NarrativeChangeEventInput {
                    object_key: json!({
                        "kind": "identity-correction-rule",
                        "ruleId": rule_id,
                    }),
                    change_kind: "policy".to_string(),
                    mutation_kind: if supersedes_revision_id.is_some() {
                        "update".to_string()
                    } else {
                        "create".to_string()
                    },
                    before_version: supersedes_revision_id
                        .as_ref()
                        .map(|_| revision_no - 1),
                    before_digest: None,
                    after_version: Some(revision_no),
                    after_digest: None,
                    changed_paths: vec!["/identity-correction-rule-revisions".to_string()],
                    text_impact: None,
                    structural_impact: None,
                }],
            };
            // Identity-correction events have a strict three-key privacy contract.
            without_renderer_authority_context(|| {
                append_canonical_and_narrative_change_in_tx(
                    conn,
                    &project_id,
                    &session_id,
                    &canonical_event,
                    &narrative_input,
                )
            })?;
            Ok((project_id.clone(), load_row(conn, RULE_REVISIONS, &create_revision_id)?.ok_or_else(|| {
                anyhow::anyhow!("identity correction revision was not persisted")
            })?))
        },
        move |conn| load_row(conn, RULE_REVISIONS, &load_revision_id),
    )?;
    Ok(outcome.into_wire_value())
}

pub fn list_current_rule_revisions(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<Value>> {
    let rows = Database::execute_with_conn(
        conn,
        "SELECT revision.*
           FROM identity_correction_rule_revisions revision
          WHERE revision.project_id = ?1
            AND revision.state = 'active'
            AND NOT EXISTS (
                SELECT 1
                  FROM identity_correction_rule_revisions successor
                 WHERE successor.project_id = revision.project_id
                   AND successor.supersedes_revision_id = revision.id
            )
          ORDER BY revision.rule_id, revision.revision_no",
        &[Value::String(project_id.to_string())],
        "all",
    )?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

pub fn get_rule_revision(
    conn: &Connection,
    project_id: &str,
    id: &str,
) -> anyhow::Result<Option<Value>> {
    let rows = Database::execute_with_conn(
        conn,
        "SELECT * FROM identity_correction_rule_revisions
          WHERE project_id = ?1 AND id = ?2",
        &[
            Value::String(project_id.to_string()),
            Value::String(id.to_string()),
        ],
        "all",
    )?;
    Ok(rows.first().cloned().map(Value::Object))
}

impl RuleRevisionFields {
    fn normalize_pair_order(&mut self) -> anyhow::Result<()> {
        if !matches!(
            self.kind.as_str(),
            "cannot-link-entries" | "suppressed-merge-candidate"
        ) {
            return Ok(());
        }
        let entry_id = self
            .entry_id
            .take()
            .ok_or_else(|| anyhow::anyhow!("entryId is required for {}", self.kind))?;
        let other_entry_id = self
            .other_entry_id
            .take()
            .ok_or_else(|| anyhow::anyhow!("otherEntryId is required for {}", self.kind))?;
        anyhow::ensure!(entry_id != other_entry_id, "entry pair must contain two entries");
        if entry_id < other_entry_id {
            self.entry_id = Some(entry_id);
            self.other_entry_id = Some(other_entry_id);
        } else {
            self.entry_id = Some(other_entry_id);
            self.other_entry_id = Some(entry_id);
        }
        Ok(())
    }

    fn validate_and_normalize(
        &mut self,
        conn: &Connection,
        project_id: &str,
    ) -> anyhow::Result<()> {
        self.normalize_pair_order()?;
        match self.scope_kind.as_str() {
            "any" => anyhow::ensure!(
                self.scope_scene_id.is_none(),
                "any scope cannot name a scene"
            ),
            "exact" => {
                let scene_id = required(self.scope_scene_id.as_deref(), "scopeSceneId")?;
                let exists: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM tree_nodes
                     WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene')",
                    params![scene_id, project_id],
                    |row| row.get(0),
                )?;
                anyhow::ensure!(exists, "scope scene does not exist in project");
            }
            _ => anyhow::bail!("scopeKind must be any or exact"),
        }
        if let Some(reason) = self.reason.as_deref() {
            required(Some(reason), "reason")?;
        }

        match self.kind.as_str() {
            "must-link-surface" | "preferred-binding" => {
                required(self.surface_text.as_deref(), "surfaceText")?;
                required(self.entry_id.as_deref(), "entryId")?;
                anyhow::ensure!(
                    self.other_entry_id.is_none()
                        && self.canonical_name.is_none()
                        && self.keep_previous_as_alias.is_none(),
                    "{} accepts only surfaceText and entryId",
                    self.kind
                );
            }
            "cannot-link-entries" | "suppressed-merge-candidate" => {
                required(self.entry_id.as_deref(), "entryId")?;
                required(self.other_entry_id.as_deref(), "otherEntryId")?;
                anyhow::ensure!(
                    self.surface_text.is_none()
                        && self.canonical_name.is_none()
                        && self.keep_previous_as_alias.is_none(),
                    "{} accepts only entryId and otherEntryId",
                    self.kind
                );
            }
            "preferred-canonical-name" => {
                required(self.entry_id.as_deref(), "entryId")?;
                required(self.canonical_name.as_deref(), "canonicalName")?;
                anyhow::ensure!(
                    self.keep_previous_as_alias.is_some(),
                    "keepPreviousAsAlias is required for preferred-canonical-name"
                );
                anyhow::ensure!(
                    self.surface_text.is_none() && self.other_entry_id.is_none(),
                    "preferred-canonical-name accepts only entryId and canonicalName"
                );
            }
            _ => anyhow::bail!("unsupported identity correction rule kind"),
        }

        for entry_id in [self.entry_id.as_deref(), self.other_entry_id.as_deref()]
            .into_iter()
            .flatten()
        {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM codex_entries
                 WHERE id = ?1 AND project_id = ?2)",
                params![entry_id, project_id],
                |row| row.get(0),
            )?;
            anyhow::ensure!(exists, "Codex entry does not exist in project");
        }
        Ok(())
    }
}

fn required<'a>(value: Option<&'a str>, field: &str) -> anyhow::Result<&'a str> {
    let value = value.ok_or_else(|| anyhow::anyhow!("{field} is required"))?;
    anyhow::ensure!(!value.trim().is_empty(), "{field} must be non-empty");
    Ok(value)
}

fn ensure_project_exists(conn: &Connection, project_id: &str) -> anyhow::Result<()> {
    required(Some(project_id), "projectId")?;
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        params![project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(exists, "project does not exist");
    Ok(())
}

fn require_current_revision(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
) -> anyhow::Result<Value> {
    let previous = get_rule_revision(conn, project_id, revision_id)?
        .ok_or_else(|| anyhow::anyhow!("target revision is not in project"))?;
    anyhow::ensure!(
        previous.get("state").and_then(Value::as_str) == Some("active"),
        "target revision is not current"
    );
    let has_successor: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM identity_correction_rule_revisions
         WHERE project_id = ?1 AND supersedes_revision_id = ?2)",
        params![project_id, revision_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(!has_successor, "target revision already has a successor");
    Ok(previous)
}

fn string_column(row: &Value, name: &str) -> anyhow::Result<String> {
    row.get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("rule revision {name} is missing"))
}

fn integer_column(row: &Value, name: &str) -> anyhow::Result<i64> {
    row.get(name)
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("rule revision {name} is missing"))
}

fn fields_from_row(row: &Value) -> anyhow::Result<RuleRevisionFields> {
    let optional_string = |name: &str| {
        row.get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    Ok(RuleRevisionFields {
        kind: string_column(row, "kind")?,
        scope_kind: string_column(row, "scope_kind")?,
        scope_scene_id: optional_string("scope_scene_id"),
        surface_text: optional_string("surface_text"),
        entry_id: optional_string("entry_id"),
        other_entry_id: optional_string("other_entry_id"),
        canonical_name: optional_string("canonical_name"),
        keep_previous_as_alias: row
            .get("keep_previous_as_alias")
            .and_then(Value::as_i64)
            .map(|value| value != 0),
        reason: optional_string("reason"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent_writes::RendererMutationProvenance,
        change_events::with_renderer_authority_context,
        test_support::current_schema_memory,
    };
    use rusqlite::types::ValueRef;
    use std::collections::BTreeSet;

    const PROJECT_A: &str = "identity-project-a";
    const PROJECT_B: &str = "identity-project-b";

    fn test_db() -> Database {
        current_schema_memory().expect("current schema fixture")
    }

    fn seed_projects(db: &Database) {
        db.with_conn(|conn| {
            for project_id in [PROJECT_A, PROJECT_B] {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES (?1, ?2)",
                    params![project_id, project_id],
                )?;
            }
            for (id, project_id, name) in [
                ("entry-secret-id", PROJECT_A, "Hidden person"),
                ("entry-peer-secret-id", PROJECT_A, "Peer"),
                ("entry-b", PROJECT_A, "Other"),
                ("foreign-entry-id", PROJECT_B, "Foreign"),
            ] {
                conn.execute(
                    "INSERT INTO codex_entries (id, project_id, type, name)
                     VALUES (?1, ?2, 'character', ?3)",
                    params![id, project_id, name],
                )?;
            }
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title)
                 VALUES ('scene-secret-id', ?1, 'scene', 'Scene'),
                        ('scene-b', ?1, 'scene', 'Scene B')",
                params![PROJECT_A],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title)
                 VALUES ('foreign-scene-id', ?1, 'scene', 'Foreign Scene')",
                params![PROJECT_B],
            )?;
            Ok(())
        })
        .expect("seed projects, entries and scenes");
    }

    fn human_authority(request_id: &str) -> RendererCanonicalWriteContext {
        authority_for_route("human-direct", request_id)
    }

    fn authority_for_route(route: &str, request_id: &str) -> RendererCanonicalWriteContext {
        let (caller, origin, controls, provenance, original_transaction_id, undo_journal_id) =
            match route {
                "human-direct" => (
                    "human-ui",
                    NarrativeChangeOrigin::Human,
                    vec![
                        "runtime-policy",
                        "actor-context",
                        "typed-writer",
                        "occ",
                        "change-event",
                        "change-feed",
                    ],
                    None,
                    None,
                    None,
                ),
                "interactive-agent-command" => (
                    "chat-tool-executor",
                    NarrativeChangeOrigin::AiApply,
                    vec![
                        "knowledge-write-policy",
                        "stable-request-id",
                        "agent-provenance",
                        "field-authority",
                        "typed-writer",
                        "occ",
                        "undo-journal",
                        "change-event",
                        "change-feed",
                    ],
                    Some(RendererMutationProvenance {
                        request_id: request_id.to_string(),
                        trace_id: "agent-trace".to_string(),
                        chat_message_id: None,
                        tool_call_id: None,
                        execution_id: None,
                        main_owned_provenance_id: None,
                    }),
                    None,
                    None,
                ),
                "import-apply" => (
                    "import-session",
                    NarrativeChangeOrigin::Import,
                    vec![
                        "import-policy",
                        "source-package-evidence",
                        "typed-writer",
                        "occ",
                        "change-event",
                        "change-feed",
                    ],
                    None,
                    None,
                    None,
                ),
                "history-replay" => (
                    "history-controller",
                    NarrativeChangeOrigin::Undo,
                    vec![
                        "original-transaction",
                        "journal-lineage",
                        "typed-writer",
                        "occ",
                        "change-event",
                        "change-feed",
                    ],
                    None,
                    Some("original-tx".to_string()),
                    Some("undo-journal".to_string()),
                ),
                "restore-or-migration" => (
                    "migration-runner",
                    NarrativeChangeOrigin::Migration,
                    vec![
                        "exclusive-system-operation",
                        "semantic-epoch-event",
                        "full-rebuild-marker",
                    ],
                    None,
                    None,
                    None,
                ),
                _ => (
                    "untrusted-caller",
                    NarrativeChangeOrigin::Human,
                    Vec::new(),
                    None,
                    None,
                    None,
                ),
            };
        RendererCanonicalWriteContext {
            request_id: request_id.to_string(),
            event_uid: format!("event-{request_id}"),
            authority_session_id: None,
            origin,
            authority_route: route.to_string(),
            caller: caller.to_string(),
            controls: controls.into_iter().map(str::to_string).collect(),
            provenance,
            writes_authority_protected_field: false,
            original_transaction_id,
            undo_journal_id,
            context_mode: None,
            icon: None,
            children_budget: None,
            notes: None,
            canonical_payload: None,
        }
    }

    fn context() -> RuleRevisionWriteContext {
        RuleRevisionWriteContext {
            session_id: "session-1".to_string(),
        }
    }

    fn surface_rule() -> RuleRevisionFields {
        RuleRevisionFields {
            kind: "must-link-surface".to_string(),
            scope_kind: "exact".to_string(),
            scope_scene_id: Some("scene-secret-id".to_string()),
            surface_text: Some("HiddenName-319".to_string()),
            entry_id: Some("entry-secret-id".to_string()),
            other_entry_id: None,
            canonical_name: None,
            keep_previous_as_alias: None,
            reason: Some("why-secret-phrase".to_string()),
        }
    }

    fn payload(fields: RuleRevisionFields) -> RuleRevisionPayload {
        RuleRevisionPayload {
            project_id: PROJECT_A.to_string(),
            fields,
            context: context(),
        }
    }

    fn list_current(db: &Database, project_id: &str) -> Vec<Value> {
        db.with_conn(|conn| list_current_rule_revisions(conn, project_id))
            .expect("list current rule revisions")
    }

    fn get_revision(db: &Database, project_id: &str, id: &str) -> Value {
        db.with_conn(|conn| get_rule_revision(conn, project_id, id))
            .expect("get rule revision")
            .expect("rule revision exists")
    }

    fn assert_event_contract(db: &Database) {
        db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT * FROM change_events
                  WHERE project_id = ?1 AND domain = 'identity-correction'
                  ORDER BY sequence",
            )?;
            let column_names = statement
                .column_names()
                .map(str::to_string)
                .collect::<Vec<_>>();
            let mut rows = statement.query(params![PROJECT_A])?;
            let mut event_count = 0;
            while let Some(row) = rows.next()? {
                event_count += 1;
                assert_eq!(row.get::<_, Option<String>>("scene_id")?, None);
                assert_eq!(
                    row.get::<_, String>("entity_type")?,
                    "identity_correction_rule"
                );
                let payload_text: String = row.get("payload")?;
                let payload: Value = serde_json::from_str(&payload_text).expect("event payload");
                let keys = payload
                    .as_object()
                    .expect("payload object")
                    .keys()
                    .cloned()
                    .collect::<BTreeSet<_>>();
                assert_eq!(
                    keys,
                    ["kind", "ruleId", "ruleRevisionId"]
                        .into_iter()
                        .map(str::to_string)
                        .collect()
                );
                let revision_id = payload["ruleRevisionId"]
                    .as_str()
                    .expect("payload revision id");
                let (rule_id, kind): (String, String) = conn.query_row(
                    "SELECT rule_id, kind FROM identity_correction_rule_revisions
                      WHERE project_id = ?1 AND id = ?2",
                    params![PROJECT_A, revision_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert_eq!(payload["ruleId"].as_str(), Some(rule_id.as_str()));
                assert_eq!(payload["kind"].as_str(), Some(kind.as_str()));
                let entity_id: String = row.get("entity_id")?;
                assert_eq!(
                    entity_id,
                    revision_id
                );
                assert_eq!(row.get::<_, String>("domain")?, "identity-correction");
                assert_eq!(row.get::<_, String>("op_type")?, "rule.revise");
                for (index, column_name) in column_names.iter().enumerate() {
                    if let ValueRef::Text(value) = row.get_ref(index)? {
                        let value = String::from_utf8_lossy(value);
                        for secret in [
                            "HiddenName-319",
                            "entry-secret-id",
                            "entry-peer-secret-id",
                            "scene-secret-id",
                            "why-secret-phrase",
                        ] {
                            assert!(
                                !value.contains(secret),
                                "{secret} leaked through change_events.{}",
                                column_name
                            );
                        }
                    }
                }
            }
            assert_eq!(event_count, 3);

            let mut keys = conn.prepare(
                "SELECT object_key_json FROM narrative_change_events
                  WHERE project_id = ?1 ORDER BY canonical_sequence, event_ordinal",
            )?;
            let mut key_rows = keys.query_map(params![PROJECT_A], |row| row.get::<_, String>(0))?;
            let mut objects = Vec::new();
            for key in &mut key_rows {
                objects.push(serde_json::from_str::<Value>(&key?)?);
            }
            assert_eq!(objects.len(), 3);
            let rule_id = objects[0]["ruleId"]
                .as_str()
                .expect("rule id")
                .to_string();
            for object_key in objects {
                assert_eq!(
                    object_key,
                    json!({
                        "kind": "identity-correction-rule",
                        "ruleId": rule_id.clone(),
                    })
                );
            }
            Ok(())
        })
        .expect("event privacy contract");
    }

    #[test]
    fn create_supersede_retire_and_idempotent_replay_keep_revision_chain() {
        let db = test_db();
        seed_projects(&db);
        let first = with_renderer_authority_context(
            json!({"authorityRoute":"human-direct", "caller":"human-ui"}),
            || create_rule_revision(&db, payload(surface_rule()), human_authority("request-1")),
        )
        .expect("create first revision");
        assert_eq!(first["revision_no"], 1);
        assert_eq!(first["state"], "active");
        let first_id = first["id"].as_str().expect("first id").to_string();
        let rule_id = first["rule_id"].as_str().expect("rule id").to_string();
        assert_eq!(first["entry_id"], "entry-secret-id");
        assert_eq!(first["scope_scene_id"], "scene-secret-id");
        assert_eq!(list_current(&db, PROJECT_A).len(), 1);
        assert_eq!(
            get_revision(&db, PROJECT_A, &first_id)["rule_id"],
            rule_id
        );

        let replay = create_rule_revision(&db, payload(surface_rule()), human_authority("request-1"))
            .expect("replay create");
        assert_eq!(replay["id"], first["id"]);
        assert_eq!(replay["rule_id"], first["rule_id"]);

        let pair_rule = RuleRevisionFields {
            kind: "cannot-link-entries".to_string(),
            scope_kind: "any".to_string(),
            scope_scene_id: None,
            surface_text: None,
            entry_id: Some("entry-peer-secret-id".to_string()),
            other_entry_id: Some("entry-secret-id".to_string()),
            canonical_name: None,
            keep_previous_as_alias: None,
            reason: Some("why-secret-phrase".to_string()),
        };
        let second = supersede_rule_revision(
            &db,
            &first_id,
            payload(pair_rule.clone()),
            human_authority("request-2"),
        )
        .expect("supersede revision");
        assert_eq!(second["revision_no"], 2);
        assert_eq!(second["supersedes_revision_id"], first_id);
        assert_eq!(second["rule_id"], rule_id);
        assert_eq!(second["entry_id"], "entry-peer-secret-id");
        assert_eq!(second["other_entry_id"], "entry-secret-id");
        let second_id = second["id"].as_str().expect("second id").to_string();
        let second_replay = supersede_rule_revision(
            &db,
            &first_id,
            payload(pair_rule),
            human_authority("request-2"),
        )
        .expect("replay supersede");
        assert_eq!(second_replay["id"], second["id"]);

        let retired = retire_rule_revision(
            &db,
            RetireRuleRevisionPayload {
                project_id: PROJECT_A.to_string(),
                previous_revision_id: second_id.clone(),
                context: context(),
            },
            human_authority("request-3"),
        )
        .expect("retire rule");
        assert_eq!(retired["revision_no"], 3);
        assert_eq!(retired["state"], "retired");
        assert_eq!(retired["supersedes_revision_id"], second_id);
        assert!(list_current(&db, PROJECT_A).is_empty());
        let retired_replay = retire_rule_revision(
            &db,
            RetireRuleRevisionPayload {
                project_id: PROJECT_A.to_string(),
                previous_revision_id: second["id"].as_str().unwrap().to_string(),
                context: context(),
            },
            human_authority("request-3"),
        )
        .expect("replay retire");
        assert_eq!(retired_replay["id"], retired["id"]);

        let count: i64 = db
            .with_conn(|conn| {
                let count = conn.query_row(
                    "SELECT COUNT(*) FROM change_events WHERE domain = 'identity-correction'",
                    [],
                    |row| row.get(0),
                )?;
                Ok(count)
            })
            .unwrap();
        assert_eq!(count, 3);
        assert_event_contract(&db);
    }

    #[test]
    fn non_human_routes_are_rejected_by_native_writer() {
        let db = test_db();
        seed_projects(&db);
        let agent_error = create_rule_revision(
            &db,
            payload(surface_rule()),
            authority_for_route("interactive-agent-command", "non-human-agent"),
        )
        .expect_err("agent route must fail at the native route check")
        .to_string();
        assert!(
            agent_error.contains(
                "Authority route 'interactive-agent-command' is not allowed for this writer"
            ),
            "agent route must be rejected by the writer allowlist: {agent_error}"
        );

        for (index, route) in [
            "import-apply",
            "history-replay",
            "restore-or-migration",
            "maintenance",
            "mcp",
        ]
        .into_iter()
        .enumerate()
        {
            let request_id = format!("non-human-{index}");
            let result = create_rule_revision(
                &db,
                payload(surface_rule()),
                authority_for_route(route, &request_id),
            );
            assert!(result.is_err(), "route {route} must be rejected");
        }
    }

    #[test]
    fn rejects_cross_project_missing_and_non_current_references() {
        let db = test_db();
        seed_projects(&db);

        let mut foreign_entry = surface_rule();
        foreign_entry.entry_id = Some("foreign-entry-id".to_string());
        assert!(create_rule_revision(
            &db,
            payload(foreign_entry),
            human_authority("foreign-entry"),
        )
        .is_err());

        let mut missing_entry = surface_rule();
        missing_entry.entry_id = Some("missing-entry-id".to_string());
        assert!(create_rule_revision(
            &db,
            payload(missing_entry),
            human_authority("missing-entry"),
        )
        .is_err());

        let mut missing_scene = surface_rule();
        missing_scene.scope_scene_id = Some("missing-scene-id".to_string());
        assert!(create_rule_revision(
            &db,
            payload(missing_scene),
            human_authority("missing-scene"),
        )
        .is_err());

        let foreign = create_rule_revision(
            &db,
            RuleRevisionPayload {
                project_id: PROJECT_B.to_string(),
                fields: RuleRevisionFields {
                    scope_kind: "any".to_string(),
                    scope_scene_id: None,
                    entry_id: Some("foreign-entry-id".to_string()),
                    ..surface_rule()
                },
                context: context(),
            },
            human_authority("foreign-revision"),
        )
        .expect("create rule in second project");
        assert!(supersede_rule_revision(
            &db,
            foreign["id"].as_str().unwrap(),
            payload(surface_rule()),
            human_authority("cross-project-supersede"),
        )
        .is_err());

        let original = create_rule_revision(
            &db,
            payload(surface_rule()),
            human_authority("chain-original"),
        )
        .expect("create chain base");
        let next = supersede_rule_revision(
            &db,
            original["id"].as_str().unwrap(),
            payload(surface_rule()),
            human_authority("chain-next"),
        )
        .expect("supersede chain base");
        assert!(supersede_rule_revision(
            &db,
            original["id"].as_str().unwrap(),
            payload(surface_rule()),
            human_authority("chain-second-child"),
        )
        .is_err());
        assert_eq!(next["revision_no"], 2);

        let mut missing_required = surface_rule();
        missing_required.surface_text = None;
        assert!(create_rule_revision(
            &db,
            payload(missing_required),
            human_authority("missing-required"),
        )
        .is_err());
    }
}
