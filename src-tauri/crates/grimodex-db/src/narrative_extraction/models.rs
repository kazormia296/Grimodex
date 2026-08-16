//! Narrative extraction run / task / proposal DTOs (JSON wire = camelCase).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunPayload {
    #[serde(default)]
    pub run_id: Option<String>,
    pub project_id: String,
    pub surface_path_id: String,
    pub scope_json: Value,
    pub spec_json: Value,
    pub spec_digest: String,
    #[serde(default)]
    pub snapshot_digest: Option<String>,
    #[serde(default)]
    pub catalog_digest: Option<String>,
    #[serde(default)]
    pub registry_digest: Option<String>,
    #[serde(default)]
    pub coverage_json: Option<Value>,
    #[serde(default)]
    pub tasks: Vec<CreateTaskSeed>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskSeed {
    #[serde(default)]
    pub task_id: Option<String>,
    pub task_kind: String,
    #[serde(default)]
    pub input_json: Option<Value>,
    #[serde(default)]
    pub priority: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRefPayload {
    pub run_id: String,
    pub project_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimTaskPayload {
    pub run_id: String,
    pub project_id: String,
    pub lease_owner: String,
    #[serde(default)]
    pub lease_duration_secs: Option<i64>,
    #[serde(default)]
    pub task_kinds: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishTaskPayload {
    pub run_id: String,
    pub project_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub lease_owner: String,
    #[serde(default)]
    pub output_json: Option<Value>,
    #[serde(default)]
    pub artifacts: Vec<ArtifactInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailTaskPayload {
    pub run_id: String,
    pub project_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub lease_owner: String,
    pub error_message: String,
    #[serde(default)]
    pub output_json: Option<Value>,
    #[serde(default)]
    pub requeue: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInput {
    #[serde(default)]
    pub artifact_id: Option<String>,
    pub artifact_kind: String,
    #[serde(default)]
    pub payload_storage: Option<String>,
    #[serde(default)]
    pub payload_json: Option<Value>,
    #[serde(default)]
    pub payload_ref: Option<String>,
    #[serde(default)]
    pub payload_digest: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProposalSetPayload {
    pub run_id: String,
    pub project_id: String,
    #[serde(default)]
    pub proposal_set_id: Option<String>,
    pub set_kind: String,
    #[serde(default)]
    pub summary_json: Option<Value>,
    pub proposals: Vec<ProposalSeed>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalSeed {
    #[serde(default)]
    pub proposal_id: Option<String>,
    pub proposal_key: String,
    pub kind: String,
    pub payload_json: Value,
    #[serde(default)]
    pub reconciliation_envelope: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationEnvelopeInheritance {
    pub parent_revision_id: String,
    pub expected_envelope_digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendRevisionPayload {
    pub run_id: String,
    pub project_id: String,
    pub proposal_id: String,
    pub payload_json: Value,
    #[serde(default)]
    pub reconciliation_envelope: Option<Value>,
    /// Explicit CAS mode for carrying the current envelope to a new revision.
    /// Omission means the new revision is intentionally legacy-unbound.
    #[serde(default)]
    pub inherit_reconciliation_envelope: Option<ReconciliationEnvelopeInheritance>,
    /// Optimistic concurrency: must match `narrative_proposals.current_revision_id`.
    pub expected_current_revision_id: String,
    #[serde(default)]
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendDecisionPayload {
    pub run_id: String,
    pub project_id: String,
    pub proposal_id: String,
    pub revision_id: String,
    pub decision: String,
    #[serde(default)]
    pub decision_json: Option<Value>,
    #[serde(default)]
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviseAndDecidePayload {
    pub run_id: String,
    pub project_id: String,
    pub proposal_id: String,
    pub payload_json: Value,
    #[serde(default)]
    pub reconciliation_envelope: Option<Value>,
    /// Explicit CAS mode for carrying the current envelope to a new revision.
    /// Omission means the new revision is intentionally legacy-unbound.
    #[serde(default)]
    pub inherit_reconciliation_envelope: Option<ReconciliationEnvelopeInheritance>,
    /// Optimistic concurrency: must match `narrative_proposals.current_revision_id`.
    pub expected_current_revision_id: String,
    pub decision: String,
    #[serde(default)]
    pub decision_json: Option<Value>,
    #[serde(default)]
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityBindingSeed {
    pub narrative_entity_id: String,
    pub codex_entry_id: String,
    #[serde(default = "default_existing_source")]
    pub source: String,
}

fn default_existing_source() -> String {
    "existing".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareCommitPayload {
    pub project_id: String,
    pub run_id: String,
    pub proposal_set_id: String,
    pub request_id: String,
    pub plan_digest: String,
    pub session_id: String,
    #[serde(default)]
    pub surface: Option<String>,
    pub operations: Vec<CommitOperation>,
    /// Required 1:1 with `operations` — Native is mutation authority and must
    /// not accept proposal-free apply payloads.
    pub applications: Vec<CommitApplicationRef>,
    /// Compiler-observed tail ordinal (`null` when the project had no events).
    #[serde(default)]
    pub expected_tail_ordinal: Option<String>,
    /// Existing-only NarrativeEntityId → Codex entry bindings for CommitMap.
    #[serde(default)]
    pub entity_bindings: Vec<EntityBindingSeed>,
    /// OCC for `project_calendar.version`, required whenever the plan carries
    /// a Temporal Constraint Graph operation that resolves absolute literals
    /// against the calendar. `None` skips the check for calendar-independent
    /// plans (missing calendar rows read as version 0).
    #[serde(default)]
    pub expected_calendar_version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyCommitPayload {
    pub project_id: String,
    pub prepared_commit_id: String,
    pub request_id: String,
    pub session_id: String,
    #[serde(default)]
    pub expected_version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOperation {
    pub kind: String,
    pub payload: Value,
    pub proposal_id: String,
    pub revision_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResumableRunsPayload {
    pub project_id: String,
    #[serde(default)]
    pub surface_path_id: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitApplicationRef {
    pub proposal_id: String,
    pub revision_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCommitStatusPayload {
    pub project_id: String,
    #[serde(default)]
    pub commit_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoCommitPayload {
    pub project_id: String,
    pub session_id: String,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub commit_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanFieldLockPayload {
    pub project_id: String,
    pub entity_kind: String,
    pub entity_id: String,
    pub field_path: String,
    pub expected_version: i64,
    pub locked: bool,
}

pub(crate) fn default_object_json() -> Value {
    Value::Object(Default::default())
}

// ─────────────────────── Gate C2-T1 Transport Assembly ───────────────────
// Wire payloads for the C2 commands promoted from pub(crate) to pub during
// Transport Assembly: Lane D's Attention typed writer and Lane O's
// Maintenance Inbox read model.

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeMaintenanceAttentionSetPayload {
    pub project_id: String,
    pub finding_key: String,
    /// One of `AttentionDisposition::as_str()`'s three values
    /// (`"snoozed"`/`"dismissed"`/`"flagged"`); validated by
    /// `AttentionDisposition::try_from` in the N-API handler, not here, so
    /// the fail-closed error path stays the same as every other Gate C2
    /// disposition/reason-code string.
    pub disposition: String,
    pub material_basis_digest: String,
    #[serde(default)]
    pub snoozed_until: Option<String>,
    /// Who is recording this disposition. Required (SCHEMA 25): the nullable
    /// `setBy` this replaced let an Attention row exist with nobody
    /// accountable for it.
    pub actor_id: String,
    /// Caller-supplied request identity. A retry carrying the same
    /// `requestId` and the same decision is a replay, not a second decision.
    pub request_id: String,
    #[serde(default)]
    pub reason: Option<String>,
    /// OCC token: the `version` the caller believes the row is at, or `0`
    /// when it believes no row exists yet.
    pub expected_version: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeMaintenanceAttentionClearPayload {
    pub project_id: String,
    pub finding_key: String,
    pub actor_id: String,
    pub request_id: String,
    pub expected_version: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeMaintenanceInboxListPayload {
    pub project_id: String,
}

// ─────────────────────── Gate C2 Run Kind Policy IPC ───────────────────
// Wire payloads for the five named operations
// (`policies/narrative/narrative-run-kind-policy.json`'s `apiSplit`)
// replacing the old two-value `rebuildNarrativeDependencyIndex(mode:
// verify|repair)` shape.

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyNarrativeDependencyGraphPayload {
    pub project_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildNarrativeDerivedStatePayload {
    pub project_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNarrativeBackfillStatusPayload {
    pub project_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryNarrativeLegacyBackfillPayload {
    pub project_id: String,
}

/// `apply: false` (default) seals and returns a repair plan preview
/// without executing it -- the policy's `change-count-preview`
/// precondition. `apply: true` executes: `plan_digest` must match the
/// digest a preview call just returned (binds the confirmation to the
/// exact plan the human saw, not a blind re-seal that could differ if
/// the Durable Graph changed in between) and `lease_owner` identifies
/// the caller claiming the exclusive Repair lease.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairNarrativeDependencyDeclarationsPayload {
    pub project_id: String,
    pub verify_run_id: String,
    #[serde(default)]
    pub apply: bool,
    #[serde(default)]
    pub plan_digest: Option<String>,
    #[serde(default)]
    pub lease_owner: Option<String>,
}
