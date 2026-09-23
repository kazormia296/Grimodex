//! Native-only durable generation observations and reference lineage.
//!
//! These operations do not authorize a model call or qualify history. In
//! particular, `claim_attempt` is only a durable one-shot CAS. Its caller must
//! serialize the current profile, workspace, route and material authorization
//! with the claim before invoking its transport. No operation here resends.

use anyhow::{ensure, Context, Result};
use grimodex_core::narrative_nir1_receipt::{
    validate_terminal_matrix, Completion, OutputChannel, OutputObserver, ParseStatus,
    ProviderTerminal, TerminalObservation, TerminalStatus, OUTPUT_DIGEST_VERSION,
};
use grimodex_core::{canonical_json_digest, canonical_json_string};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Instant;
use uuid::Uuid;

use crate::narrative_extraction::{
    validation_terminated, with_immediate_transaction, ValidationTerminationReason,
};
use crate::narrative_maintenance_connection::{
    ParticipantSqlControl, ParticipantSqlOperationBudget,
};
use crate::state::ActiveWorkspaceSnapshot;
use crate::Database;

// These are storage safety ceilings for malformed/imported rows. They bound
// one Native materialization; they are not the owning turn's history or
// transport capacity contract.
const MAX_ID_BYTES: usize = 4 * 1024;
const MAX_BINDING_JSON_BYTES: usize = 64 * 1024;
const MAX_TERMINAL_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_MESSAGE_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_MESSAGE_METADATA_BYTES: usize = 2 * 1024 * 1024;
const MAX_SHORT_TEXT_BYTES: usize = 256;
const MAX_DIGEST_BYTES: usize = 128;
const ATTEMPT_MISSING_ERROR: &str = "NIR1_GENERATION_ATTEMPT_MISSING";
const MAX_RECOVERY_PAGE_SIZE: usize = 64;

/// The read-only history callback observes the same owner cancellation token
/// as the SQLite progress hook.  It never touches the lifecycle or database
/// mutex, so JSON parsing checkpoints remain safe inside the outer scope.
#[derive(Clone, Debug)]
pub(crate) struct GenerationHistorySnapshotCancellation {
    stop: Arc<AtomicBool>,
    deadline: Option<Instant>,
}

impl GenerationHistorySnapshotCancellation {
    pub(crate) fn from_control(control: &ParticipantSqlControl) -> Self {
        Self {
            stop: Arc::clone(&control.stop),
            deadline: control.deadline,
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.stop.load(Ordering::Acquire)
            || self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
    }

    pub(crate) fn checkpoint(&self) -> Result<()> {
        let reason = if self.stop.load(Ordering::Acquire) {
            Some(ValidationTerminationReason::Cancelled)
        } else if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            Some(ValidationTerminationReason::TimedOut)
        } else {
            None
        };
        if let Some(reason) = reason {
            return Err(validation_terminated(
                reason,
                "generation history snapshot owner stopped the read",
            ));
        }
        Ok(())
    }
}

fn bounded_sqlite_length(length: i64, limit: usize, error: &str) -> Result<usize> {
    ensure!(length >= 0, "{}", error);
    let length = usize::try_from(length).map_err(|_| anyhow::anyhow!("{error}"))?;
    ensure!(length <= limit, "{}", error);
    Ok(length)
}

fn bounded_optional_sqlite_length(
    length: Option<i64>,
    limit: usize,
    error: &str,
) -> Result<Option<usize>> {
    length
        .map(|length| bounded_sqlite_length(length, limit, error))
        .transpose()
}

fn is_confirmed_missing_attempt(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string() == ATTEMPT_MISSING_ERROR)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GenerationPurpose {
    Writing,
    Review,
}

/// Exact Native-owned identities; endpoint identity is a credential-free
/// digest, never a URL. The opaque workspace identity includes the existing
/// authority instance/recovery generation, not merely a project or path.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptBinding {
    pub project_id: String,
    pub session_id: String,
    pub profile_id: String,
    pub caller_id: String,
    pub caller_epoch: u64,
    pub workspace_binding_digest: String,
    pub purpose: GenerationPurpose,
    pub scope_digest: String,
    pub material_digest: String,
    pub d1_digest: String,
    pub route_revision: String,
    pub provider: String,
    pub model: String,
    pub api: String,
    pub endpoint_identity: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputRole {
    System,
    User,
    Assistant,
    Context,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InputTarget {
    Message {
        version_id: String,
        parent_attempt_id: Option<String>,
    },
    Artifact {
        artifact_id: String,
        payload_digest: String,
    },
    RawSource {
        source_key: String,
        revision_token: String,
    },
    AcceptedRevision {
        revision_id: String,
        bundle_digest: String,
    },
    GraphEvidence {
        evidence_ref: String,
        source_key: String,
        revision_token: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputReference {
    pub role: InputRole,
    pub target: InputTarget,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum QualificationKind {
    Source,
    Revision,
    Decision,
    Freshness,
    Index,
    Scope,
    D1,
}

/// Exact reference/version only. Qualification content is never copied here.
/// `input_ordinal` identifies the adopted input whose full qualification this
/// reference belongs to; an accepted Revision is not split into new authorities.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualificationReference {
    pub input_ordinal: usize,
    pub kind: QualificationKind,
    pub identity: String,
    pub version: String,
}

/// Limits are selected by the owning turn. This storage layer does not invent
/// product history capacity numbers or reset a budget separately per ancestor.
#[derive(Clone, Copy, Debug)]
pub struct ReadBudget {
    pub max_references: usize,
    pub max_reference_bytes: usize,
}

/// Caller-owned limits for one history snapshot read. The history owner is
/// responsible for choosing these values and sharing them across its whole
/// turn; this reader never resets them per ancestor or candidate.
#[derive(Debug)]
pub(crate) struct GenerationHistoryReadBudget {
    pub max_attempts: usize,
    /// Caller-owned upper bound for one candidate page. The storage reader
    /// never chooses a product default; the adapter checks this before it
    /// opens a transaction or allocates traversal results.
    pub max_candidates: usize,
    pub max_reference_count: usize,
    pub max_reference_bytes: usize,
    pub max_resolved_body_bytes: usize,
    /// Caller-owned whole-turn traversal limits. These counters are shared
    /// with the pure history walk; they are deliberately not defaults owned
    /// by storage and are never reset for a candidate or ancestor.
    pub remaining_nodes: usize,
    pub remaining_edges: usize,
    pub remaining_qualification_refs: usize,
}

impl GenerationHistoryReadBudget {
    fn child_reference_budget(&self) -> ReadBudget {
        ReadBudget {
            max_references: self.max_reference_count,
            max_reference_bytes: self.max_reference_bytes,
        }
    }

    fn apply_child_reference_budget(&mut self, budget: ReadBudget) {
        self.max_reference_count = budget.max_references;
        self.max_reference_bytes = budget.max_reference_bytes;
    }

    fn consume_attempt(&mut self) -> Result<()> {
        ensure!(self.max_attempts > 0, "NIR1_GENERATION_HISTORY_LIMIT");
        self.max_attempts -= 1;
        Ok(())
    }

    fn reserve_body_bytes(&mut self, bytes: usize) -> Result<()> {
        ensure!(
            bytes <= self.max_resolved_body_bytes,
            "NIR1_GENERATION_HISTORY_BODY_LIMIT"
        );
        self.max_resolved_body_bytes -= bytes;
        Ok(())
    }

    /// Debit one whole-turn history node. The history adapter maps this
    /// storage error to its typed `BudgetExhausted` result.
    pub(crate) fn consume_node(&mut self) -> Result<()> {
        ensure!(
            self.remaining_nodes > 0,
            "NIR1_GENERATION_HISTORY_BUDGET_EXHAUSTED"
        );
        self.remaining_nodes -= 1;
        Ok(())
    }

    /// Debit one whole-turn history edge.
    pub(crate) fn consume_edge(&mut self) -> Result<()> {
        ensure!(
            self.remaining_edges > 0,
            "NIR1_GENERATION_HISTORY_BUDGET_EXHAUSTED"
        );
        self.remaining_edges -= 1;
        Ok(())
    }

    /// Debit qualification references from the same whole-turn ledger as
    /// node and edge visits.
    pub(crate) fn consume_qualification_refs(&mut self, count: usize) -> Result<()> {
        ensure!(
            self.remaining_qualification_refs >= count,
            "NIR1_GENERATION_HISTORY_BUDGET_EXHAUSTED"
        );
        self.remaining_qualification_refs -= count;
        Ok(())
    }
}

/// A message version plus the immutable chat row it authenticates. The body
/// is returned only as owned values after scalar length admission. There is no
/// borrowed connection or JSON value in this type.
#[derive(Clone, Debug)]
pub(crate) struct GenerationHistoryMessage {
    pub version: MessageVersion,
    pub chat_role: String,
    pub content: String,
    pub metadata: Option<Value>,
    pub created_at: String,
}

/// Artifact identity is readable from the existing artifact store, but the
/// schema has no NIR generation producer receipt link. Those fields therefore
/// remain absent and history qualification must fail closed for artifact
/// lineage until a confirmed immutable extension supplies them.
#[derive(Clone, Debug)]
pub(crate) struct GenerationHistoryArtifact {
    pub artifact_id: String,
    pub project_id: String,
    pub payload_digest: String,
    pub producer_attempt_id: Option<String>,
    pub producer_receipt_digest: Option<String>,
}

#[derive(Clone, Debug)]
pub struct NewAttempt {
    pub binding: AttemptBinding,
    pub payload_digest: String,
    pub inputs: Vec<InputReference>,
    pub qualifications: Vec<QualificationReference>,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub budget: ReadBudget,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredAttempt {
    pub id: String,
    pub binding: AttemptBinding,
    pub payload_digest: String,
    pub input_digest: String,
    pub inputs: Vec<InputReference>,
    pub qualifications: Vec<QualificationReference>,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub claimed_at_ms: Option<i64>,
    pub terminal: Option<StoredTerminal>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MessageOrigin {
    Human,
    Generated,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageVersion {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub message_id: String,
    pub origin: MessageOrigin,
    pub body_digest: String,
    pub parent_attempt_id: Option<String>,
    pub created_at_ms: i64,
}

/// Canonical text and thinking live only in the existing chat_messages row.
/// Thinking uses the existing metadata.thinking_blocks representation.
#[derive(Clone, Debug)]
pub struct NewMessageBody {
    pub message_id: String,
    pub content: String,
    pub thinking: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureClassification {
    InvalidOutput,
    DispatchUnavailable,
    Cancelled,
    Skipped,
    InterruptedUnknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetryClassification {
    NotApplicable,
    NewAttemptRequired,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredTerminal {
    pub attempt_id: String,
    pub payload_digest: String,
    pub input_digest: String,
    pub message_version: Option<MessageVersion>,
    pub observation: Value,
    pub failure_classification: Option<FailureClassification>,
    pub retry_classification: RetryClassification,
    pub completed_at_ms: i64,
    pub receipt_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedObservation {
    digest_version: String,
    provider_terminal: Option<ProviderTerminal>,
    terminal_status: TerminalStatus,
    parse_status: ParseStatus,
    text_digest: String,
    thinking_digest: String,
    response_digest: Option<String>,
}

fn identity(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.trim() == value && value.len() <= MAX_ID_BYTES,
        "NIR1_GENERATION_INVALID_ID"
    );
    Ok(())
}

fn digest(value: &str) -> Result<()> {
    ensure!(
        value
            .strip_prefix("sha256:")
            .is_some_and(|hex| hex.len() == 64
                && hex
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))),
        "NIR1_GENERATION_INVALID_DIGEST"
    );
    Ok(())
}

fn validate_binding(binding: &AttemptBinding) -> Result<()> {
    for value in [
        &binding.project_id,
        &binding.session_id,
        &binding.profile_id,
        &binding.caller_id,
        &binding.route_revision,
        &binding.provider,
        &binding.model,
        &binding.api,
    ] {
        identity(value)?;
    }
    for value in [
        &binding.workspace_binding_digest,
        &binding.scope_digest,
        &binding.material_digest,
        &binding.d1_digest,
        &binding.endpoint_identity,
    ] {
        digest(value)?;
    }
    Ok(())
}

fn input_digest(
    inputs: &[InputReference],
    qualifications: &[QualificationReference],
) -> Result<String> {
    Ok(canonical_json_digest(
        &json!({"domain":"nir1-generation-inputs@1",
        "inputs":inputs,"qualifications":qualifications}),
    )?)
}

fn require_session(conn: &Connection, project: &str, session: &str) -> Result<()> {
    ensure!(
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE id=?1 AND project_id=?2)",
            params![session, project],
            |row| row.get::<_, bool>(0)
        )?,
        "NIR1_GENERATION_SESSION_MISMATCH"
    );
    Ok(())
}

fn validate_refs(
    conn: &Connection,
    binding: &AttemptBinding,
    inputs: &[InputReference],
    qualifications: &[QualificationReference],
    budget: ReadBudget,
) -> Result<()> {
    let count = inputs
        .len()
        .checked_add(qualifications.len())
        .context("NIR1_GENERATION_REF_LIMIT")?;
    ensure!(count <= budget.max_references, "NIR1_GENERATION_REF_LIMIT");
    let mut bytes = 0usize;
    let mut parent_reference_budget = budget;
    let mut parent_receipts = BTreeMap::<String, Option<(bool, Option<MessageVersion>)>>::new();
    for input in inputs {
        bytes = bytes
            .checked_add(serde_json::to_vec(input)?.len())
            .context("NIR1_GENERATION_REF_LIMIT")?;
        match &input.target {
            InputTarget::Message {
                version_id,
                parent_attempt_id,
            } => {
                let version = read_message_version_in_tx(conn, version_id)?;
                ensure!(
                    version.project_id == binding.project_id
                        && version.session_id == binding.session_id
                        && &version.parent_attempt_id == parent_attempt_id,
                    "NIR1_GENERATION_MESSAGE_BINDING_MISMATCH"
                );
                match version.origin {
                    MessageOrigin::Human => ensure!(
                        input.role == InputRole::User,
                        "NIR1_GENERATION_MESSAGE_ROLE_MISMATCH"
                    ),
                    MessageOrigin::Generated => {
                        ensure!(
                            input.role == InputRole::Assistant,
                            "NIR1_GENERATION_MESSAGE_ROLE_MISMATCH"
                        );
                        let parent_id = parent_attempt_id
                            .as_deref()
                            .context("NIR1_GENERATION_PARENT_REQUIRED")?;
                        let parent_receipt = if let Some(receipt) = parent_receipts.get(parent_id) {
                            receipt.clone()
                        } else {
                            let parent = read_attempt_in_tx_with_remaining(
                                conn,
                                parent_id,
                                &mut parent_reference_budget,
                            )?;
                            let receipt = parent.terminal.map(|terminal| {
                                (
                                    terminal.observation["terminalStatus"] == "succeeded",
                                    terminal.message_version,
                                )
                            });
                            parent_receipts.insert(parent_id.to_owned(), receipt.clone());
                            receipt
                        };
                        let (parent_succeeded, parent_version) =
                            parent_receipt.context("NIR1_GENERATION_PARENT_UNFINISHED")?;
                        ensure!(
                            parent_succeeded && parent_version.as_ref() == Some(&version),
                            "NIR1_GENERATION_PARENT_UNQUALIFIED"
                        );
                    }
                }
            }
            InputTarget::Artifact {
                artifact_id,
                payload_digest,
            } => {
                identity(artifact_id)?;
                digest(payload_digest)?;
                let found_length = conn
                    .query_row(
                        "SELECT octet_length(a.payload_digest)
                         FROM narrative_extraction_artifacts a
                         JOIN narrative_extraction_runs r ON r.id=a.run_id
                         WHERE a.id=?1 AND r.project_id=?2",
                        params![artifact_id, binding.project_id],
                        |row| row.get::<_, Option<i64>>(0),
                    )
                    .optional()?
                    .flatten();
                let found = if let Some(found_length) = found_length {
                    let expected_length = bounded_sqlite_length(
                        found_length,
                        MAX_DIGEST_BYTES,
                        "NIR1_GENERATION_ARTIFACT_DIGEST_LIMIT",
                    )?;
                    let found: String = conn.query_row(
                        "SELECT a.payload_digest
                         FROM narrative_extraction_artifacts a
                         JOIN narrative_extraction_runs r ON r.id=a.run_id
                         WHERE a.id=?1 AND r.project_id=?2",
                        params![artifact_id, binding.project_id],
                        |row| row.get(0),
                    )?;
                    ensure!(
                        found.len() == expected_length,
                        "NIR1_GENERATION_ARTIFACT_DIGEST_CHANGED"
                    );
                    Some(found)
                } else {
                    None
                };
                ensure!(
                    found.as_ref() == Some(payload_digest),
                    "NIR1_GENERATION_ARTIFACT_MISMATCH"
                );
            }
            InputTarget::RawSource {
                source_key,
                revision_token,
            } => {
                identity(source_key)?;
                identity(revision_token)?;
            }
            InputTarget::AcceptedRevision {
                revision_id,
                bundle_digest,
            } => {
                identity(revision_id)?;
                digest(bundle_digest)?;
            }
            InputTarget::GraphEvidence {
                evidence_ref,
                source_key,
                revision_token,
            } => {
                identity(evidence_ref)?;
                identity(source_key)?;
                identity(revision_token)?;
            }
        }
    }
    for reference in qualifications {
        ensure!(
            reference.input_ordinal < inputs.len(),
            "NIR1_GENERATION_QUALIFICATION_INPUT_MISSING"
        );
        identity(&reference.identity)?;
        identity(&reference.version)?;
        bytes = bytes
            .checked_add(serde_json::to_vec(reference)?.len())
            .context("NIR1_GENERATION_REF_LIMIT")?;
    }
    ensure!(
        bytes <= budget.max_reference_bytes,
        "NIR1_GENERATION_REF_LIMIT"
    );
    Ok(())
}

pub fn create_attempt(db: &Database, request: NewAttempt) -> Result<StoredAttempt> {
    validate_binding(&request.binding)?;
    digest(&request.payload_digest)?;
    ensure!(
        request.created_at_ms >= 0 && request.expires_at_ms > request.created_at_ms,
        "NIR1_GENERATION_INVALID_EXPIRY"
    );
    db.with_conn(|conn| with_immediate_transaction(conn, |conn| {
        require_session(conn, &request.binding.project_id, &request.binding.session_id)?;
        validate_refs(conn, &request.binding, &request.inputs, &request.qualifications, request.budget)?;
        let id = Uuid::new_v4().to_string();
        let input_digest = input_digest(&request.inputs, &request.qualifications)?;
        let binding_json = canonical_json_string(&serde_json::to_value(&request.binding)?)?;
        ensure!(
            binding_json.len() <= MAX_BINDING_JSON_BYTES,
            "NIR1_GENERATION_BINDING_LIMIT"
        );
        conn.execute("INSERT INTO nir1_generation_attempts
            (id,project_id,session_id,binding_json,payload_digest,input_digest,created_at_ms,expires_at_ms)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![id,request.binding.project_id,
            request.binding.session_id,binding_json,
            request.payload_digest,input_digest,request.created_at_ms,request.expires_at_ms])?;
        for (ordinal, reference) in request.inputs.iter().enumerate() {
            conn.execute("INSERT INTO nir1_generation_input_refs VALUES (?1,?2,?3)",
                params![id,i64::try_from(ordinal)?,canonical_json_string(&serde_json::to_value(reference)?)?])?;
        }
        for (ordinal, reference) in request.qualifications.iter().enumerate() {
            conn.execute("INSERT INTO nir1_generation_qualification_refs VALUES (?1,?2,?3)",
                params![id,i64::try_from(ordinal)?,canonical_json_string(&serde_json::to_value(reference)?)?])?;
        }
        Ok(StoredAttempt { id,binding:request.binding,payload_digest:request.payload_digest,
            input_digest,inputs:request.inputs,qualifications:request.qualifications,
            created_at_ms:request.created_at_ms,expires_at_ms:request.expires_at_ms,claimed_at_ms:None,terminal:None })
    }))
}

/// Scalar-only reference admission. Limits apply jointly to both lists when
/// the same `ReadBudget` is passed through each table. The point fetch is
/// deliberately separate so no imported JSON is materialized before the
/// caller has admitted the whole attempt's reference page.
fn read_ref_locations_in_tx(
    conn: &Connection,
    table: &str,
    id: &str,
    remaining: &mut ReadBudget,
) -> Result<Vec<(i64, usize)>> {
    let count = i64::try_from(remaining.max_references)?
        .checked_add(1)
        .context("NIR1_GENERATION_REF_LIMIT")?;
    let sql = format!(
        "SELECT ordinal,octet_length(reference_json)
        FROM {table} WHERE attempt_id=?1 ORDER BY ordinal LIMIT ?2"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params![id, count])?;
    let mut locations = Vec::new();
    let mut page_bytes = 0usize;
    while let Some(row) = rows.next()? {
        let ordinal = row.get::<_, i64>(0)?;
        ensure!(
            ordinal == i64::try_from(locations.len())?,
            "NIR1_GENERATION_REF_ORDINAL_MISMATCH"
        );
        ensure!(
            locations.len() < remaining.max_references,
            "NIR1_GENERATION_REF_LIMIT"
        );
        let bytes = bounded_sqlite_length(
            row.get::<_, i64>(1)?,
            remaining.max_reference_bytes,
            "NIR1_GENERATION_REF_LIMIT",
        )?;
        page_bytes = page_bytes
            .checked_add(bytes)
            .context("NIR1_GENERATION_REF_LIMIT")?;
        ensure!(
            page_bytes <= remaining.max_reference_bytes,
            "NIR1_GENERATION_REF_LIMIT"
        );
        locations.push((ordinal, bytes));
    }
    drop(rows);

    remaining.max_references -= locations.len();
    remaining.max_reference_bytes -= page_bytes;
    Ok(locations)
}

fn materialize_refs_in_tx<T: serde::de::DeserializeOwned>(
    conn: &Connection,
    table: &str,
    id: &str,
    locations: &[(i64, usize)],
    cancellation: Option<&GenerationHistorySnapshotCancellation>,
) -> Result<Vec<T>> {
    let point_sql =
        format!("SELECT reference_json FROM {table} WHERE attempt_id=?1 AND ordinal=?2");
    let mut point = conn.prepare(&point_sql)?;
    let mut result = Vec::with_capacity(locations.len());
    for &(ordinal, expected_bytes) in locations {
        if let Some(cancellation) = cancellation {
            cancellation.checkpoint()?;
        }
        let raw: String = point.query_row(params![id, ordinal], |row| row.get(0))?;
        ensure!(
            raw.len() == expected_bytes,
            "NIR1_GENERATION_REF_LENGTH_CHANGED"
        );
        if let Some(cancellation) = cancellation {
            cancellation.checkpoint()?;
        }
        let value = serde_json::from_str(&raw)?;
        if let Some(cancellation) = cancellation {
            cancellation.checkpoint()?;
        }
        result.push(value);
    }
    Ok(result)
}

fn sum_materialization_bytes<I>(parts: I) -> Result<usize>
where
    I: IntoIterator<Item = usize>,
{
    parts.into_iter().try_fold(0usize, |total, bytes| {
        total
            .checked_add(bytes)
            .context("NIR1_GENERATION_HISTORY_BODY_LIMIT")
    })
}

/// Scalar-only admission for the owned attempt metadata and its raw reference
/// rows. This is separate from `ReadBudget`: the latter limits child-ref
/// lookup, while the history turn ledger limits retained/materialized bytes.
fn attempt_metadata_materialization_bytes_in_tx(conn: &Connection, id: &str) -> Result<usize> {
    let lengths: (i64, i64, i64, i64, i64) = conn
        .query_row(
            "SELECT octet_length(project_id),octet_length(session_id),
                    octet_length(binding_json),octet_length(payload_digest),
                    octet_length(input_digest)
             FROM nir1_generation_attempts WHERE id=?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?
        .context("NIR1_GENERATION_ATTEMPT_MISSING")?;
    let metadata = [
        bounded_sqlite_length(
            lengths.0,
            MAX_ID_BYTES,
            "NIR1_GENERATION_ATTEMPT_METADATA_LIMIT",
        )?,
        bounded_sqlite_length(
            lengths.1,
            MAX_ID_BYTES,
            "NIR1_GENERATION_ATTEMPT_METADATA_LIMIT",
        )?,
        bounded_sqlite_length(
            lengths.2,
            MAX_BINDING_JSON_BYTES,
            "NIR1_GENERATION_BINDING_LIMIT",
        )?,
        bounded_sqlite_length(lengths.3, MAX_DIGEST_BYTES, "NIR1_GENERATION_DIGEST_LIMIT")?,
        bounded_sqlite_length(lengths.4, MAX_DIGEST_BYTES, "NIR1_GENERATION_DIGEST_LIMIT")?,
    ];
    sum_materialization_bytes(metadata)
}

struct AttemptMetadata {
    project_id: String,
    session_id: String,
    binding_json: String,
    payload_digest: String,
    input_digest: String,
    created_at_ms: i64,
    expires_at_ms: i64,
    claimed_at_ms: Option<i64>,
}

fn read_attempt_metadata_in_tx(conn: &Connection, id: &str) -> Result<AttemptMetadata> {
    identity(id)?;
    let lengths: (i64, i64, i64, i64, i64, i64, i64, Option<i64>) = conn
        .query_row(
            "SELECT octet_length(project_id),octet_length(session_id),
        octet_length(binding_json),octet_length(payload_digest),octet_length(input_digest),
        created_at_ms,expires_at_ms,claimed_at_ms
        FROM nir1_generation_attempts WHERE id=?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                ))
            },
        )
        .optional()?
        .context("NIR1_GENERATION_ATTEMPT_MISSING")?;
    bounded_sqlite_length(
        lengths.0,
        MAX_ID_BYTES,
        "NIR1_GENERATION_ATTEMPT_METADATA_LIMIT",
    )?;
    bounded_sqlite_length(
        lengths.1,
        MAX_ID_BYTES,
        "NIR1_GENERATION_ATTEMPT_METADATA_LIMIT",
    )?;
    bounded_sqlite_length(
        lengths.2,
        MAX_BINDING_JSON_BYTES,
        "NIR1_GENERATION_BINDING_LIMIT",
    )?;
    bounded_sqlite_length(lengths.3, MAX_DIGEST_BYTES, "NIR1_GENERATION_DIGEST_LIMIT")?;
    bounded_sqlite_length(lengths.4, MAX_DIGEST_BYTES, "NIR1_GENERATION_DIGEST_LIMIT")?;
    let values: (String, String, String, String, String) = conn.query_row(
        "SELECT project_id,session_id,binding_json,payload_digest,input_digest
         FROM nir1_generation_attempts WHERE id=?1",
        [id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    digest(&values.3)?;
    digest(&values.4)?;
    Ok(AttemptMetadata {
        project_id: values.0,
        session_id: values.1,
        binding_json: values.2,
        payload_digest: values.3,
        input_digest: values.4,
        created_at_ms: lengths.5,
        expires_at_ms: lengths.6,
        claimed_at_ms: lengths.7,
    })
}

fn read_attempt_in_tx_with_remaining(
    conn: &Connection,
    id: &str,
    remaining: &mut ReadBudget,
) -> Result<StoredAttempt> {
    let mut no_reserve = |_bytes: usize| Ok(());
    read_attempt_in_tx_with_remaining_and_reserve(conn, id, remaining, &mut no_reserve, None)
}

fn read_attempt_in_tx_with_remaining_and_reserve<F>(
    conn: &Connection,
    id: &str,
    remaining: &mut ReadBudget,
    reserve: &mut F,
    cancellation: Option<&GenerationHistorySnapshotCancellation>,
) -> Result<StoredAttempt>
where
    F: FnMut(usize) -> Result<()>,
{
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let metadata_bytes = attempt_metadata_materialization_bytes_in_tx(conn, id)?;
    let mut reference_budget = *remaining;
    let input_locations = read_ref_locations_in_tx(
        conn,
        "nir1_generation_input_refs",
        id,
        &mut reference_budget,
    )?;
    let qualification_locations = read_ref_locations_in_tx(
        conn,
        "nir1_generation_qualification_refs",
        id,
        &mut reference_budget,
    )?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let reference_bytes = sum_materialization_bytes(
        input_locations
            .iter()
            .chain(qualification_locations.iter())
            .map(|(_, bytes)| *bytes),
    )?;
    reserve(sum_materialization_bytes([
        metadata_bytes,
        reference_bytes,
    ])?)?;
    *remaining = reference_budget;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let stored = read_attempt_metadata_in_tx(conn, id)?;
    let inputs: Vec<InputReference> = materialize_refs_in_tx(
        conn,
        "nir1_generation_input_refs",
        id,
        &input_locations,
        cancellation,
    )?;
    let qualifications: Vec<QualificationReference> = materialize_refs_in_tx(
        conn,
        "nir1_generation_qualification_refs",
        id,
        &qualification_locations,
        cancellation,
    )?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    ensure!(
        input_digest(&inputs, &qualifications)? == stored.input_digest,
        "NIR1_GENERATION_INPUT_DIGEST_MISMATCH"
    );
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let binding: AttemptBinding = serde_json::from_str(&stored.binding_json)?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    validate_binding(&binding)?;
    ensure!(
        binding.project_id == stored.project_id && binding.session_id == stored.session_id,
        "NIR1_GENERATION_BINDING_MISMATCH"
    );
    Ok(StoredAttempt {
        id: id.to_owned(),
        binding,
        payload_digest: stored.payload_digest,
        input_digest: stored.input_digest,
        inputs,
        qualifications,
        created_at_ms: stored.created_at_ms,
        expires_at_ms: stored.expires_at_ms,
        claimed_at_ms: stored.claimed_at_ms,
        terminal: read_terminal_in_tx_with_reserve(conn, id, reserve, false, cancellation)?,
    })
}

fn read_attempt_in_tx(conn: &Connection, id: &str, budget: ReadBudget) -> Result<StoredAttempt> {
    let mut remaining = budget;
    read_attempt_in_tx_with_remaining(conn, id, &mut remaining)
}

pub fn read_attempt(db: &Database, id: &str, budget: ReadBudget) -> Result<StoredAttempt> {
    db.with_read_transaction(|conn| read_attempt_in_tx(conn, id, budget))
}

fn message_body_lengths_in_tx(
    conn: &Connection,
    message: &str,
    project: &str,
    session: &str,
) -> Result<(usize, usize, Option<usize>, usize)> {
    let lengths: (i64, i64, Option<i64>, i64) = conn
        .query_row(
            "SELECT octet_length(m.role),octet_length(m.content),
                    octet_length(m.metadata),octet_length(m.created_at)
             FROM chat_messages m
             JOIN chat_sessions s ON s.id=m.session_id
             WHERE m.id=?1 AND m.session_id=?2 AND s.project_id=?3",
            params![message, session, project],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?
        .context("NIR1_GENERATION_MESSAGE_BODY_MISSING")?;
    let role = bounded_sqlite_length(
        lengths.0,
        MAX_SHORT_TEXT_BYTES,
        "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
    )?;
    let content = bounded_sqlite_length(
        lengths.1,
        MAX_MESSAGE_BODY_BYTES,
        "NIR1_GENERATION_MESSAGE_BODY_LIMIT",
    )?;
    let metadata = bounded_optional_sqlite_length(
        lengths.2,
        MAX_MESSAGE_METADATA_BYTES,
        "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
    )?;
    let created_at = bounded_sqlite_length(
        lengths.3,
        MAX_SHORT_TEXT_BYTES,
        "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
    )?;
    Ok((role, content, metadata, created_at))
}

fn read_message_body_after_preflight_in_tx(
    conn: &Connection,
    message: &str,
    project: &str,
    session: &str,
    lengths: (usize, usize, Option<usize>, usize),
    cancellation: Option<&GenerationHistorySnapshotCancellation>,
) -> Result<(String, String, Option<Value>, String)> {
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let (role, content, metadata, created_at): (String, String, Option<String>, String) = conn
        .query_row(
            "SELECT m.role,m.content,m.metadata,m.created_at
             FROM chat_messages m
             JOIN chat_sessions s ON s.id=m.session_id
             WHERE m.id=?1 AND m.session_id=?2 AND s.project_id=?3",
            params![message, session, project],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    ensure!(
        role.len() == lengths.0,
        "NIR1_GENERATION_MESSAGE_BODY_CHANGED"
    );
    ensure!(
        content.len() == lengths.1,
        "NIR1_GENERATION_MESSAGE_BODY_CHANGED"
    );
    ensure!(
        metadata.as_ref().map(String::len) == lengths.2,
        "NIR1_GENERATION_MESSAGE_BODY_CHANGED"
    );
    ensure!(
        created_at.len() == lengths.3,
        "NIR1_GENERATION_MESSAGE_BODY_CHANGED"
    );
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let metadata = metadata
        .map(|value| serde_json::from_str::<Value>(&value))
        .transpose()?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    Ok((role, content, metadata, created_at))
}

/// Scalar-only admission for a complete message-version read, including the
/// current chat body used to authenticate its digest. Terminal reads use this
/// before calling `read_message_version_in_tx`, so the turn ledger covers the
/// same transient/owned materialization path as direct message reads.
fn message_version_materialization_bytes_in_tx(conn: &Connection, id: &str) -> Result<usize> {
    let lengths: (
        i64,
        i64,
        i64,
        i64,
        i64,
        Option<i64>,
        i64,
        i64,
        Option<i64>,
        i64,
    ) = conn
        .query_row(
            "SELECT octet_length(v.project_id),octet_length(v.session_id),
                    octet_length(v.message_id),octet_length(v.origin),
                    octet_length(v.body_digest),octet_length(v.parent_attempt_id),
                    octet_length(m.role),octet_length(m.content),
                    octet_length(m.metadata),octet_length(m.created_at)
             FROM nir1_generation_message_versions v
             JOIN chat_messages m ON m.id=v.message_id AND m.session_id=v.session_id
             JOIN chat_sessions s ON s.id=v.session_id AND s.project_id=v.project_id
             WHERE v.id=?1 AND v.invalidated=0",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                ))
            },
        )
        .optional()?
        .context("NIR1_GENERATION_MESSAGE_VERSION_MISSING")?;
    let version = [
        bounded_sqlite_length(
            lengths.0,
            MAX_ID_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?,
        bounded_sqlite_length(
            lengths.1,
            MAX_ID_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?,
        bounded_sqlite_length(
            lengths.2,
            MAX_ID_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?,
        bounded_sqlite_length(
            lengths.3,
            MAX_SHORT_TEXT_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?,
        bounded_sqlite_length(lengths.4, MAX_DIGEST_BYTES, "NIR1_GENERATION_DIGEST_LIMIT")?,
        bounded_optional_sqlite_length(
            lengths.5,
            MAX_ID_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?
        .unwrap_or(0),
    ];
    let body = [
        bounded_sqlite_length(
            lengths.6,
            MAX_SHORT_TEXT_BYTES,
            "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
        )?,
        bounded_sqlite_length(
            lengths.7,
            MAX_MESSAGE_BODY_BYTES,
            "NIR1_GENERATION_MESSAGE_BODY_LIMIT",
        )?,
        bounded_optional_sqlite_length(
            lengths.8,
            MAX_MESSAGE_METADATA_BYTES,
            "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
        )?
        .unwrap_or(0),
        bounded_sqlite_length(
            lengths.9,
            MAX_SHORT_TEXT_BYTES,
            "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
        )?,
    ];
    sum_materialization_bytes(version.into_iter().chain(body))
}

/// A read-only view over one SQLite read transaction. Its fields are private
/// so callers can issue only the typed, owned reads below; no raw connection,
/// nested transaction, claim, writer, or transport capability crosses this
/// boundary. `StoredAttempt.binding` contains only the persisted coarse
/// digests; it is intentionally not a substitute for the full Scope-axis,
/// input-use, purpose, or send-classification tuple required by history.
pub(crate) struct GenerationHistorySnapshotReader<'connection> {
    connection: &'connection Connection,
    cancellation: GenerationHistorySnapshotCancellation,
    attempts: BTreeMap<String, std::result::Result<StoredAttempt, String>>,
    messages: BTreeMap<String, std::result::Result<GenerationHistoryMessage, String>>,
    terminals: BTreeMap<String, std::result::Result<Option<StoredTerminal>, String>>,
    artifacts: BTreeMap<(String, String), std::result::Result<GenerationHistoryArtifact, String>>,
}

impl<'connection> GenerationHistorySnapshotReader<'connection> {
    fn new(
        connection: &'connection Connection,
        cancellation: GenerationHistorySnapshotCancellation,
    ) -> Self {
        Self {
            connection,
            cancellation,
            attempts: BTreeMap::new(),
            messages: BTreeMap::new(),
            terminals: BTreeMap::new(),
            artifacts: BTreeMap::new(),
        }
    }

    pub(crate) fn checkpoint(&self) -> Result<()> {
        self.cancellation.checkpoint()
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    fn restore<T>(value: std::result::Result<T, String>) -> Result<T> {
        value.map_err(|message| anyhow::anyhow!(message))
    }

    /// Read one attempt at most once for this snapshot. Reference limits are
    /// consumed cumulatively across every attempt read through this reader.
    /// The caller passes the same turn ledger used by history traversal.
    pub(crate) fn read_attempt(
        &mut self,
        budget: &mut GenerationHistoryReadBudget,
        id: &str,
    ) -> Result<StoredAttempt> {
        identity(id)?;
        self.checkpoint()?;
        if let Some(cached) = self.attempts.get(id) {
            return Self::restore(cached.clone());
        }
        let value = match (|| {
            budget.consume_attempt()?;
            let mut references = budget.child_reference_budget();
            let mut reserve = |bytes| budget.reserve_body_bytes(bytes);
            let value = read_attempt_in_tx_with_remaining_and_reserve(
                self.connection,
                id,
                &mut references,
                &mut reserve,
                Some(&self.cancellation),
            );
            budget.apply_child_reference_budget(references);
            let value = value?;
            self.checkpoint()?;
            self.terminals
                .insert(id.to_owned(), Ok(value.terminal.clone()));
            Ok(value)
        })() {
            Ok(value) => value,
            Err(error) => {
                self.checkpoint()?;
                if is_confirmed_missing_attempt(&error) {
                    // A missing row is stable for this read transaction and
                    // is safe to negative-cache.  Keep typed cancellation,
                    // SQLite failures, budget exhaustion, and malformed rows
                    // uncached so a later call never turns them into a stale
                    // generic marker.
                    self.attempts
                        .insert(id.to_owned(), Err(ATTEMPT_MISSING_ERROR.to_owned()));
                }
                return Err(error);
            }
        };
        self.checkpoint()?;
        self.attempts.insert(id.to_owned(), Ok(value.clone()));
        Ok(value)
    }

    /// Read an authenticated message version and its current chat body from
    /// this snapshot. The scalar body admission occurs before the canonical
    /// version reader materializes content or metadata.
    pub(crate) fn read_message(
        &mut self,
        budget: &mut GenerationHistoryReadBudget,
        id: &str,
    ) -> Result<GenerationHistoryMessage> {
        identity(id)?;
        self.checkpoint()?;
        if let Some(cached) = self.messages.get(id) {
            return Self::restore(cached.clone());
        }
        let value = match (|| {
            // The version row can be imported independently of the chat row.
            // Read only scalar lengths before fetching any identifier String;
            // otherwise a malformed message_id/project_id/session_id can
            // allocate before the canonical version reader's guard runs.
            let identifier_lengths: (i64, i64, i64) = self
                .connection
                .query_row(
                    "SELECT octet_length(message_id),octet_length(project_id),
                            octet_length(session_id)
                     FROM nir1_generation_message_versions
                     WHERE id=?1 AND invalidated=0",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .context("NIR1_GENERATION_MESSAGE_VERSION_MISSING")?;
            let identifier_lengths = [
                bounded_sqlite_length(
                    identifier_lengths.0,
                    MAX_ID_BYTES,
                    "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
                )?,
                bounded_sqlite_length(
                    identifier_lengths.1,
                    MAX_ID_BYTES,
                    "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
                )?,
                bounded_sqlite_length(
                    identifier_lengths.2,
                    MAX_ID_BYTES,
                    "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
                )?,
            ];
            let (message, project, session): (String, String, String) = self.connection.query_row(
                "SELECT message_id,project_id,session_id
                     FROM nir1_generation_message_versions
                     WHERE id=?1 AND invalidated=0",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            ensure!(
                message.len() == identifier_lengths[0]
                    && project.len() == identifier_lengths[1]
                    && session.len() == identifier_lengths[2],
                "NIR1_GENERATION_MESSAGE_VERSION_CHANGED"
            );
            self.checkpoint()?;
            let lengths =
                message_body_lengths_in_tx(self.connection, &message, &project, &session)?;
            budget.reserve_body_bytes(message_version_materialization_bytes_in_tx(
                self.connection,
                id,
            )?)?;
            self.checkpoint()?;
            let version = read_message_version_in_tx_with_cancellation(
                self.connection,
                id,
                Some(&self.cancellation),
            )?;
            let (chat_role, content, metadata, created_at) =
                read_message_body_after_preflight_in_tx(
                    self.connection,
                    &message,
                    &project,
                    &session,
                    lengths,
                    Some(&self.cancellation),
                )?;
            self.checkpoint()?;
            Ok(GenerationHistoryMessage {
                version,
                chat_role,
                content,
                metadata,
                created_at,
            })
        })() {
            Ok(value) => value,
            Err(error) => {
                self.checkpoint()?;
                return Err(error);
            }
        };
        self.checkpoint()?;
        self.messages.insert(id.to_owned(), Ok(value.clone()));
        Ok(value)
    }

    /// Return the durable terminal already read with an attempt, or read it
    /// once from the same snapshot. No write or claim path is reachable here.
    pub(crate) fn read_terminal(
        &mut self,
        budget: &mut GenerationHistoryReadBudget,
        id: &str,
    ) -> Result<Option<StoredTerminal>> {
        identity(id)?;
        self.checkpoint()?;
        if let Some(cached) = self.terminals.get(id) {
            return Self::restore(cached.clone());
        }
        let value = match (|| {
            budget.consume_attempt()?;
            let mut reserve = |bytes| budget.reserve_body_bytes(bytes);
            read_terminal_in_tx_with_reserve(
                self.connection,
                id,
                &mut reserve,
                true,
                Some(&self.cancellation),
            )
        })() {
            Ok(value) => value,
            Err(error) => {
                self.checkpoint()?;
                if is_confirmed_missing_attempt(&error) {
                    // A missing row is stable for this read transaction and
                    // is safe to negative-cache. Keep typed cancellation,
                    // SQLite failures, budget exhaustion, and malformed rows
                    // uncached so a later call never turns them into a stale
                    // generic marker.
                    self.terminals
                        .insert(id.to_owned(), Err(ATTEMPT_MISSING_ERROR.to_owned()));
                }
                return Err(error);
            }
        };
        self.checkpoint()?;
        self.terminals.insert(id.to_owned(), Ok(value.clone()));
        Ok(value)
    }

    /// Read the existing artifact identity and digest. The current schema has
    /// no immutable NIR generation producer/receipt relation, so those fields
    /// are deliberately `None`; history code must exclude this lineage.
    pub(crate) fn read_artifact(
        &mut self,
        _budget: &mut GenerationHistoryReadBudget,
        project: &str,
        artifact_id: &str,
        expected_payload_digest: &str,
    ) -> Result<GenerationHistoryArtifact> {
        identity(project)?;
        identity(artifact_id)?;
        digest(expected_payload_digest)?;
        self.checkpoint()?;
        let key = (project.to_owned(), artifact_id.to_owned());
        if let Some(cached) = self.artifacts.get(&key) {
            let value = Self::restore(cached.clone())?;
            ensure!(
                value.payload_digest == expected_payload_digest,
                "NIR1_GENERATION_ARTIFACT_MISMATCH"
            );
            return Ok(value);
        }
        let value = match (|| {
            let lengths: (i64, i64, Option<i64>) = self
                .connection
                .query_row(
                    "SELECT octet_length(a.id),octet_length(r.project_id),
                            octet_length(a.payload_digest)
                     FROM narrative_extraction_artifacts a
                     JOIN narrative_extraction_runs r ON r.id=a.run_id
                     WHERE a.id=?1 AND r.project_id=?2",
                    params![artifact_id, project],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .context("NIR1_GENERATION_ARTIFACT_MISSING")?;
            bounded_sqlite_length(lengths.0, MAX_ID_BYTES, "NIR1_GENERATION_ARTIFACT_LIMIT")?;
            bounded_sqlite_length(lengths.1, MAX_ID_BYTES, "NIR1_GENERATION_ARTIFACT_LIMIT")?;
            let payload_length = lengths.2.context("NIR1_GENERATION_ARTIFACT_MISMATCH")?;
            bounded_sqlite_length(
                payload_length,
                MAX_DIGEST_BYTES,
                "NIR1_GENERATION_ARTIFACT_DIGEST_LIMIT",
            )?;
            let (artifact_id, project_id, payload_digest): (String, String, String) =
                self.connection.query_row(
                    "SELECT a.id,r.project_id,a.payload_digest
                     FROM narrative_extraction_artifacts a
                     JOIN narrative_extraction_runs r ON r.id=a.run_id
                     WHERE a.id=?1 AND r.project_id=?2",
                    params![artifact_id, project],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            ensure!(
                artifact_id.len() <= MAX_ID_BYTES
                    && project_id.len() <= MAX_ID_BYTES
                    && payload_digest.len() == usize::try_from(payload_length)?,
                "NIR1_GENERATION_ARTIFACT_CHANGED"
            );
            self.checkpoint()?;
            digest(&payload_digest)?;
            ensure!(
                payload_digest == expected_payload_digest,
                "NIR1_GENERATION_ARTIFACT_MISMATCH"
            );
            Ok(GenerationHistoryArtifact {
                artifact_id,
                project_id,
                payload_digest,
                producer_attempt_id: None,
                producer_receipt_digest: None,
            })
        })() {
            Ok(value) => value,
            Err(error) => {
                self.checkpoint()?;
                return Err(error);
            }
        };
        self.checkpoint()?;
        self.artifacts.insert(key, Ok(value.clone()));
        Ok(value)
    }
}

/// Keep one participant-owned read transaction open until the callback
/// returns. The callback receives only the typed reader and an owned
/// cancellation view, so it cannot open a nested transaction, mutate the
/// database, claim an attempt, or dispatch transport. Its result must be
/// owned because the higher-ranked callback lifetime cannot escape.
pub(crate) fn with_generation_history_snapshot<T, F>(
    workspace: &ActiveWorkspaceSnapshot,
    control: ParticipantSqlControl,
    caller_budget: &mut GenerationHistoryReadBudget,
    read_snapshot: F,
) -> Result<T>
where
    F: for<'connection> FnOnce(
        &mut GenerationHistorySnapshotReader<'connection>,
        &mut GenerationHistoryReadBudget,
        &GenerationHistorySnapshotCancellation,
    ) -> Result<T>,
{
    let cancellation = GenerationHistorySnapshotCancellation::from_control(&control);
    let callback_cancellation = cancellation.clone();
    workspace.db().with_participant_read_transaction_control(
        workspace.participant(),
        control,
        move |connection| {
            with_generation_history_snapshot_in_tx(
                connection,
                &callback_cancellation,
                caller_budget,
                |reader, budget| read_snapshot(reader, budget, &callback_cancellation),
            )
        },
    )
}

/// Run a typed snapshot reader on an already-owned transaction. This helper
/// never acquires the Database mutex or installs/resets a progress handler;
/// its caller must already be inside the one outer participant scope.
pub(crate) fn with_generation_history_snapshot_in_tx<T, F>(
    connection: &Connection,
    cancellation: &GenerationHistorySnapshotCancellation,
    caller_budget: &mut GenerationHistoryReadBudget,
    read_snapshot: F,
) -> Result<T>
where
    F: for<'connection> FnOnce(
        &mut GenerationHistorySnapshotReader<'connection>,
        &mut GenerationHistoryReadBudget,
    ) -> Result<T>,
{
    cancellation.checkpoint()?;
    let mut reader = GenerationHistorySnapshotReader::new(connection, cancellation.clone());
    read_snapshot(&mut reader, caller_budget)
}

/// Only a durable CAS, never full dispatch authorization. The coordinator must
/// use the same exact immutable request and serialize its external authorities.
pub fn claim_attempt(
    db: &Database,
    id: &str,
    binding: &AttemptBinding,
    now_ms: i64,
    budget: ReadBudget,
) -> Result<bool> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            claim_attempt_in_tx(conn, id, binding, now_ms, budget)
        })
    })
}

/// Nonserializable proof of validation in the still-owned fresh write
/// transaction. It cannot be moved to another connection or transaction.
/// Dropping it without commit rolls back; it never dispatches a transport.
pub struct PreparedClaim<'connection> {
    transaction: Transaction<'connection>,
    attempt_id: String,
    created_at_ms: i64,
    expires_at_ms: i64,
}

impl PreparedClaim<'_> {
    /// Invoke only inside the coordinator's final profile/workspace/current
    /// route guards. Only a constant-size conditional UPDATE and COMMIT run
    /// here; reference/body reads happened before those guards were acquired.
    pub fn commit(self, now_ms: i64) -> Result<bool> {
        ensure!(
            now_ms >= self.created_at_ms && now_ms < self.expires_at_ms,
            "NIR1_GENERATION_EXPIRED"
        );
        let won = self.transaction.execute(
            "UPDATE nir1_generation_attempts SET claimed_at_ms=?2
            WHERE id=?1 AND claimed_at_ms IS NULL AND terminal_json IS NULL",
            params![self.attempt_id, now_ms],
        )? == 1;
        self.transaction.commit()?;
        Ok(won)
    }
}

/// Pin and validate the final DB inputs before taking profile/lifecycle locks.
/// The callback owns their exact ordering and consumes the claim while they
/// remain held. A participant SQL/capacity owner is rejected before DB locking
/// because its progress hook could re-enter those authority locks.
pub fn with_prepared_claim(
    db: &Database,
    id: &str,
    binding: &AttemptBinding,
    budget: ReadBudget,
    authorize: impl FnOnce(PreparedClaim<'_>) -> Result<bool>,
) -> Result<bool> {
    ensure!(
        !crate::narrative_extraction::nir1_capacity::attempt_active()
            && !crate::narrative_maintenance_connection::any_sql_owner_scope_active(),
        "NIR1_GENERATION_CLAIM_SQL_OWNER_ACTIVE"
    );
    let result = db.with_conn(|conn| {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
            let attempt = read_attempt_in_tx(&transaction, id, budget)?;
            ensure!(
                &attempt.binding == binding,
                "NIR1_GENERATION_BINDING_MISMATCH"
            );
            require_session(&transaction, &binding.project_id, &binding.session_id)?;
            validate_refs(
                &transaction,
                binding,
                &attempt.inputs,
                &attempt.qualifications,
                budget,
            )?;
            authorize(PreparedClaim {
                transaction,
                attempt_id: id.to_owned(),
                created_at_ms: attempt.created_at_ms,
                expires_at_ms: attempt.expires_at_ms,
            })
        }));
        if !conn.is_autocommit() {
            db.quarantine_connection("generation claim transaction cleanup unproven");
            if result.is_ok() {
                anyhow::bail!("NIR1_GENERATION_CLAIM_CLEANUP_UNPROVEN");
            }
        }
        Ok(result)
    })?;
    // Resume only after Database::with_conn has dropped its mutex normally.
    // A clean transaction rollback must not poison the reusable DB mutex.
    match result {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// The coordinator owns this fresh transaction, the external authority guards,
/// and its commit. A stale read snapshot is not a latest dispatch check.
pub fn claim_attempt_in_tx(
    conn: &Connection,
    id: &str,
    binding: &AttemptBinding,
    now_ms: i64,
    budget: ReadBudget,
) -> Result<bool> {
    ensure!(
        !crate::narrative_extraction::nir1_capacity::attempt_active()
            && !crate::narrative_maintenance_connection::any_sql_owner_scope_active(),
        "NIR1_GENERATION_CLAIM_SQL_OWNER_ACTIVE"
    );
    ensure!(
        !conn.is_autocommit(),
        "NIR1_GENERATION_TRANSACTION_REQUIRED"
    );
    let attempt = read_attempt_in_tx(conn, id, budget)?;
    ensure!(
        &attempt.binding == binding,
        "NIR1_GENERATION_BINDING_MISMATCH"
    );
    ensure!(
        now_ms >= attempt.created_at_ms && now_ms < attempt.expires_at_ms,
        "NIR1_GENERATION_EXPIRED"
    );
    require_session(conn, &binding.project_id, &binding.session_id)?;
    validate_refs(
        conn,
        binding,
        &attempt.inputs,
        &attempt.qualifications,
        budget,
    )?;
    Ok(conn.execute(
        "UPDATE nir1_generation_attempts SET claimed_at_ms=?2
            WHERE id=?1 AND claimed_at_ms IS NULL AND terminal_json IS NULL",
        params![id, now_ms],
    )? == 1)
}

fn message_digest_in_tx(
    conn: &Connection,
    message: &str,
    project: &str,
    session: &str,
) -> Result<(String, String)> {
    let lengths: (i64, i64, Option<i64>, i64) = conn
        .query_row(
            "SELECT octet_length(m.role),octet_length(m.content),
             octet_length(m.metadata),octet_length(m.created_at)
             FROM chat_messages m
             JOIN chat_sessions s ON s.id=m.session_id
             WHERE m.id=?1 AND m.session_id=?2 AND s.project_id=?3",
            params![message, session, project],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?
        .context("NIR1_GENERATION_MESSAGE_MISSING")?;
    bounded_sqlite_length(
        lengths.0,
        MAX_SHORT_TEXT_BYTES,
        "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
    )?;
    bounded_sqlite_length(
        lengths.1,
        MAX_MESSAGE_BODY_BYTES,
        "NIR1_GENERATION_MESSAGE_BODY_LIMIT",
    )?;
    bounded_optional_sqlite_length(
        lengths.2,
        MAX_MESSAGE_METADATA_BYTES,
        "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
    )?;
    bounded_sqlite_length(
        lengths.3,
        MAX_SHORT_TEXT_BYTES,
        "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
    )?;
    let (role, content, metadata, created_at): (String, String, Option<String>, String) = conn
        .query_row(
            "SELECT m.role,m.content,m.metadata,m.created_at FROM chat_messages m
             JOIN chat_sessions s ON s.id=m.session_id
             WHERE m.id=?1 AND m.session_id=?2 AND s.project_id=?3",
            params![message, session, project],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    let metadata = metadata
        .map(|value| serde_json::from_str::<Value>(&value))
        .transpose()?;
    let thinking = metadata
        .as_ref()
        .and_then(|value| value.get("thinking_blocks"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok((
        canonical_json_digest(
            &json!({"domain":"nir1-message-version@1","messageId":message,
            "projectId":project,"sessionId":session,"role":&role,"content":content,
            "thinkingBlocks":thinking,"createdAt":created_at}),
        )?,
        role,
    ))
}

fn read_message_version_in_tx(conn: &Connection, id: &str) -> Result<MessageVersion> {
    read_message_version_in_tx_with_cancellation(conn, id, None)
}

fn read_message_version_in_tx_with_cancellation(
    conn: &Connection,
    id: &str,
    cancellation: Option<&GenerationHistorySnapshotCancellation>,
) -> Result<MessageVersion> {
    identity(id)?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let lengths: (i64, i64, i64, i64, i64, Option<i64>, i64) = conn
        .query_row(
            "SELECT octet_length(project_id),octet_length(session_id),octet_length(message_id),
        octet_length(origin),octet_length(body_digest),octet_length(parent_attempt_id),
        created_at_ms FROM nir1_generation_message_versions WHERE id=?1 AND invalidated=0",
            [id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()?
        .context("NIR1_GENERATION_MESSAGE_VERSION_MISSING")?;
    for length in [lengths.0, lengths.1, lengths.2] {
        bounded_sqlite_length(
            length,
            MAX_ID_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?;
    }
    bounded_sqlite_length(
        lengths.3,
        MAX_SHORT_TEXT_BYTES,
        "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
    )?;
    bounded_sqlite_length(lengths.4, MAX_DIGEST_BYTES, "NIR1_GENERATION_DIGEST_LIMIT")?;
    bounded_optional_sqlite_length(
        lengths.5,
        MAX_ID_BYTES,
        "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
    )?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let row: (String, String, String, String, String, Option<String>) = conn.query_row(
        "SELECT project_id,session_id,message_id,origin,body_digest,parent_attempt_id
         FROM nir1_generation_message_versions WHERE id=?1 AND invalidated=0",
        [id],
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
    )?;
    let origin = match row.3.as_str() {
        "human" => MessageOrigin::Human,
        "generated" => MessageOrigin::Generated,
        _ => anyhow::bail!("NIR1_GENERATION_MESSAGE_ORIGIN_INVALID"),
    };
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let (body_digest, role) = message_digest_in_tx(conn, &row.2, &row.0, &row.1)?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let expected_role = match origin {
        MessageOrigin::Human => "user",
        MessageOrigin::Generated => "assistant",
    };
    ensure!(
        role == expected_role,
        "NIR1_GENERATION_MESSAGE_ROLE_MISMATCH"
    );
    ensure!(
        body_digest == row.4,
        "NIR1_GENERATION_MESSAGE_BODY_MISMATCH"
    );
    Ok(MessageVersion {
        id: id.to_owned(),
        project_id: row.0,
        session_id: row.1,
        message_id: row.2,
        origin,
        body_digest: row.4,
        parent_attempt_id: row.5,
        created_at_ms: lengths.6,
    })
}

pub fn read_message_version(db: &Database, id: &str) -> Result<MessageVersion> {
    db.with_read_transaction(|conn| read_message_version_in_tx(conn, id))
}

fn bind_message_in_tx(
    conn: &Connection,
    project: &str,
    session: &str,
    message: &str,
    parent: Option<&str>,
    now_ms: i64,
) -> Result<MessageVersion> {
    let (body_digest, role) = message_digest_in_tx(conn, message, project, session)?;
    let expected_role = if parent.is_some() {
        "assistant"
    } else {
        "user"
    };
    ensure!(
        role == expected_role,
        "NIR1_GENERATION_MESSAGE_ROLE_MISMATCH"
    );
    let existing_length: Option<i64> = conn
        .query_row(
            "SELECT octet_length(id) FROM nir1_generation_message_versions WHERE message_id=?1",
            [message],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing_length) = existing_length {
        bounded_sqlite_length(
            existing_length,
            MAX_ID_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?;
        let id: String = conn.query_row(
            "SELECT id FROM nir1_generation_message_versions WHERE message_id=?1",
            [message],
            |row| row.get(0),
        )?;
        let existing = read_message_version_in_tx(conn, &id)?;
        ensure!(
            existing.project_id == project
                && existing.session_id == session
                && existing.parent_attempt_id.as_deref() == parent,
            "NIR1_GENERATION_MESSAGE_VERSION_CONFLICT"
        );
        return Ok(existing);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO nir1_generation_message_versions
        (id,project_id,session_id,message_id,origin,body_digest,parent_attempt_id,created_at_ms)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            id,
            project,
            session,
            message,
            if parent.is_some() {
                "generated"
            } else {
                "human"
            },
            body_digest,
            parent,
            now_ms
        ],
    )?;
    read_message_version_in_tx(conn, &id)
}

/// Called for an explicitly captured current human input, not for promoting an
/// arbitrary legacy history row. Native owns that origin decision.
pub fn bind_human_message(
    db: &Database,
    project: &str,
    session: &str,
    message: &str,
    now_ms: i64,
) -> Result<MessageVersion> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let role_length: Option<i64> = conn
                .query_row(
                    "SELECT octet_length(role) FROM chat_messages WHERE id=?1",
                    [message],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(role_length) = role_length else {
                anyhow::bail!("NIR1_GENERATION_HUMAN_ROLE_REQUIRED");
            };
            bounded_sqlite_length(
                role_length,
                MAX_SHORT_TEXT_BYTES,
                "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
            )?;
            let role: String = conn.query_row(
                "SELECT role FROM chat_messages WHERE id=?1",
                [message],
                |row| row.get(0),
            )?;
            ensure!(role == "user", "NIR1_GENERATION_HUMAN_ROLE_REQUIRED");
            bind_message_in_tx(conn, project, session, message, None, now_ms)
        })
    })
}

fn receipt_digest(terminal: &StoredTerminal) -> Result<String> {
    Ok(canonical_json_digest(
        &json!({"domain":"nir1-generation-receipt@1",
        "attemptId":terminal.attempt_id,"payloadDigest":terminal.payload_digest,
        "inputDigest":terminal.input_digest,"messageVersion":terminal.message_version,
        "observation":terminal.observation,"failureClassification":terminal.failure_classification,
        "retryClassification":terminal.retry_classification,"completedAtMs":terminal.completed_at_ms}),
    )?)
}

fn read_terminal_in_tx(conn: &Connection, id: &str) -> Result<Option<StoredTerminal>> {
    let mut no_reserve = |_bytes: usize| Ok(());
    read_terminal_in_tx_with_reserve(conn, id, &mut no_reserve, true, None)
}

fn read_terminal_in_tx_with_reserve<F>(
    conn: &Connection,
    id: &str,
    reserve: &mut F,
    charge_attempt_metadata: bool,
    cancellation: Option<&GenerationHistorySnapshotCancellation>,
) -> Result<Option<StoredTerminal>>
where
    F: FnMut(usize) -> Result<()>,
{
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let lengths: Option<(Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT octet_length(terminal_json),octet_length(terminal_digest)
             FROM nir1_generation_attempts WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((json_length, digest_length)) = lengths else {
        anyhow::bail!("NIR1_GENERATION_ATTEMPT_MISSING");
    };
    match (json_length, digest_length) {
        (None, None) => return Ok(None),
        (Some(json_length), Some(digest_length)) => {
            bounded_sqlite_length(
                json_length,
                MAX_TERMINAL_JSON_BYTES,
                "NIR1_GENERATION_TERMINAL_LIMIT",
            )?;
            bounded_sqlite_length(
                digest_length,
                MAX_DIGEST_BYTES,
                "NIR1_GENERATION_DIGEST_LIMIT",
            )?;
        }
        _ => anyhow::bail!("NIR1_GENERATION_RECEIPT_MISMATCH"),
    }
    if charge_attempt_metadata {
        reserve(attempt_metadata_materialization_bytes_in_tx(conn, id)?)?;
    }
    let terminal_bytes = match (json_length, digest_length) {
        (Some(json_length), Some(digest_length)) => sum_materialization_bytes([
            bounded_sqlite_length(
                json_length,
                MAX_TERMINAL_JSON_BYTES,
                "NIR1_GENERATION_TERMINAL_LIMIT",
            )?,
            bounded_sqlite_length(
                digest_length,
                MAX_DIGEST_BYTES,
                "NIR1_GENERATION_DIGEST_LIMIT",
            )?,
        ])?,
        _ => 0,
    };
    reserve(terminal_bytes)?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let (raw, stored_digest): (String, String) = conn.query_row(
        "SELECT terminal_json,terminal_digest FROM nir1_generation_attempts WHERE id=?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    digest(&stored_digest)?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let terminal: StoredTerminal = serde_json::from_str(&raw)?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    ensure!(
        terminal.attempt_id == id
            && terminal.receipt_digest == stored_digest
            && receipt_digest(&terminal)? == stored_digest,
        "NIR1_GENERATION_RECEIPT_MISMATCH"
    );
    let (terminal_status, parse_status) = validate_persisted_observation(&terminal.observation)?;
    validate_terminal_classification(
        terminal_status,
        parse_status,
        terminal.failure_classification.as_ref(),
        &terminal.retry_classification,
    )?;
    let attempt = read_attempt_metadata_in_tx(conn, id)?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let binding: AttemptBinding = serde_json::from_str(&attempt.binding_json)?;
    validate_binding(&binding)?;
    ensure!(
        binding.project_id == attempt.project_id && binding.session_id == attempt.session_id,
        "NIR1_GENERATION_BINDING_MISMATCH"
    );
    ensure!(
        terminal.payload_digest == attempt.payload_digest,
        "NIR1_GENERATION_PAYLOAD_DIGEST_MISMATCH"
    );
    ensure!(
        terminal.input_digest == attempt.input_digest,
        "NIR1_GENERATION_INPUT_DIGEST_MISMATCH"
    );
    ensure!(
        (terminal_status == TerminalStatus::Succeeded) == terminal.message_version.is_some(),
        "NIR1_GENERATION_TERMINAL_BODY_MISMATCH"
    );
    if terminal_status == TerminalStatus::Succeeded {
        ensure!(
            attempt.claimed_at_ms.is_some(),
            "NIR1_GENERATION_SUCCESS_BODY_OR_CLAIM_MISSING"
        );
    }
    if let Some(version) = terminal.message_version.as_ref() {
        if let Some(cancellation) = cancellation {
            cancellation.checkpoint()?;
        }
        reserve(message_version_materialization_bytes_in_tx(
            conn,
            &version.id,
        )?)?;
        let current =
            read_message_version_in_tx_with_cancellation(conn, &version.id, cancellation)?;
        if let Some(cancellation) = cancellation {
            cancellation.checkpoint()?;
        }
        ensure!(
            current == *version
                && version.origin == MessageOrigin::Generated
                && version.project_id == attempt.project_id
                && version.session_id == attempt.session_id
                && version.parent_attempt_id.as_deref() == Some(id),
            "NIR1_GENERATION_MESSAGE_VERSION_MISMATCH"
        );
    }
    Ok(Some(terminal))
}

/// Read and authenticate one persisted receipt and its output object. A
/// generated-parent lineage check uses `read_attempt_in_tx_with_remaining`
/// instead so the parent's stored reference rows are authenticated too.
pub fn read_terminal(db: &Database, id: &str) -> Result<Option<StoredTerminal>> {
    db.with_read_transaction(|conn| read_terminal_in_tx(conn, id))
}

fn validate_observation_fields(
    digest_version: &str,
    provider_terminal: Option<ProviderTerminal>,
    terminal_status: TerminalStatus,
    parse_status: ParseStatus,
    text_digest: &str,
    thinking_digest: &str,
    response_digest: Option<&str>,
) -> Result<()> {
    validate_terminal_matrix(terminal_status, parse_status, response_digest.is_some())
        .map_err(|_| anyhow::anyhow!("NIR1_GENERATION_OBSERVATION_INVALID"))?;
    ensure!(
        digest_version == OUTPUT_DIGEST_VERSION,
        "NIR1_GENERATION_OUTPUT_VERSION_MISMATCH"
    );
    digest(text_digest)?;
    digest(thinking_digest)?;
    if let Some(value) = response_digest {
        digest(value)?;
    }
    if terminal_status == TerminalStatus::Succeeded {
        ensure!(
            provider_terminal == Some(ProviderTerminal::Complete)
                && parse_status == ParseStatus::Parsed,
            "NIR1_GENERATION_PROVIDER_TERMINAL_REQUIRED"
        );
    }
    Ok(())
}

fn validate_observation(observation: &TerminalObservation) -> Result<()> {
    validate_observation_fields(
        observation.digest_version,
        observation.provider_terminal,
        observation.terminal_status,
        observation.parse_status,
        &observation.text_digest,
        &observation.thinking_digest,
        observation.response_digest.as_deref(),
    )
}

fn validate_persisted_observation(value: &Value) -> Result<(TerminalStatus, ParseStatus)> {
    let observation: PersistedObservation =
        serde_json::from_value(value.clone()).context("NIR1_GENERATION_OBSERVATION_INVALID")?;
    validate_observation_fields(
        &observation.digest_version,
        observation.provider_terminal,
        observation.terminal_status,
        observation.parse_status,
        &observation.text_digest,
        &observation.thinking_digest,
        observation.response_digest.as_deref(),
    )?;
    Ok((observation.terminal_status, observation.parse_status))
}

fn validate_terminal_classification(
    terminal_status: TerminalStatus,
    parse_status: ParseStatus,
    failure_classification: Option<&FailureClassification>,
    retry_classification: &RetryClassification,
) -> Result<()> {
    let valid = match (terminal_status, parse_status) {
        (TerminalStatus::Succeeded, ParseStatus::Parsed) => {
            failure_classification.is_none()
                && *retry_classification == RetryClassification::NotApplicable
        }
        (TerminalStatus::Failed, ParseStatus::Invalid) => {
            failure_classification == Some(&FailureClassification::InvalidOutput)
                && *retry_classification == RetryClassification::NewAttemptRequired
        }
        (TerminalStatus::Failed, ParseStatus::NotAttempted) => {
            matches!(
                failure_classification,
                Some(FailureClassification::DispatchUnavailable)
                    | Some(FailureClassification::InterruptedUnknown)
            ) && *retry_classification == RetryClassification::NewAttemptRequired
        }
        (TerminalStatus::Cancelled, ParseStatus::NotAttempted) => {
            failure_classification == Some(&FailureClassification::Cancelled)
                && *retry_classification == RetryClassification::NewAttemptRequired
        }
        (TerminalStatus::Skipped, ParseStatus::NotAttempted) => {
            failure_classification == Some(&FailureClassification::Skipped)
                && *retry_classification == RetryClassification::NewAttemptRequired
        }
        _ => false,
    };
    ensure!(valid, "NIR1_GENERATION_TERMINAL_CLASSIFICATION_INVALID");
    Ok(())
}

fn finish_in_tx(
    conn: &Connection,
    id: &str,
    observation: &TerminalObservation,
    body: Option<&NewMessageBody>,
    now_ms: i64,
    recovery: bool,
) -> Result<StoredTerminal> {
    validate_observation(observation)?;
    ensure!(
        observation.terminal_status == TerminalStatus::Succeeded || body.is_none(),
        "NIR1_GENERATION_NON_SUCCESS_BODY"
    );
    if let Some(body) = body {
        ensure!(
            body.content.len() <= MAX_MESSAGE_BODY_BYTES
                && body.thinking.len() <= MAX_MESSAGE_BODY_BYTES,
            "NIR1_GENERATION_MESSAGE_BODY_LIMIT"
        );
    }
    let stored = read_attempt_metadata_in_tx(conn, id)?;
    let binding: AttemptBinding = serde_json::from_str(&stored.binding_json)?;
    validate_binding(&binding)?;
    ensure!(
        binding.project_id == stored.project_id && binding.session_id == stored.session_id,
        "NIR1_GENERATION_BINDING_MISMATCH"
    );
    // Recovery records a conservative terminalization, not a provider event.
    // A regressed wall clock must not strand the attempt or place its terminal
    // before an already-durable create/claim. Live completion keeps its strict
    // timestamp validation; operation deadlines use a monotonic clock.
    let now_ms = if recovery {
        now_ms
            .max(stored.created_at_ms)
            .max(stored.claimed_at_ms.unwrap_or(stored.created_at_ms))
    } else {
        now_ms
    };
    ensure!(
        now_ms >= stored.created_at_ms,
        "NIR1_GENERATION_TIME_MISMATCH"
    );
    ensure!(
        observation.terminal_status != TerminalStatus::Succeeded
            || (stored.claimed_at_ms.is_some() && body.is_some()),
        "NIR1_GENERATION_SUCCESS_BODY_OR_CLAIM_MISSING"
    );
    if let Some(existing) = read_terminal_in_tx(conn, id)? {
        ensure!(
            existing.observation == serde_json::to_value(observation)?
                && existing
                    .message_version
                    .as_ref()
                    .map(|v| v.message_id.as_str())
                    == body.map(|b| b.message_id.as_str()),
            "NIR1_GENERATION_TERMINAL_CONFLICT"
        );
        if let Some(version) = &existing.message_version {
            read_message_version_in_tx(conn, &version.id)?;
            if let Some(body) = body {
                verify_body_observation(body, observation)?;
            }
        }
        return Ok(existing);
    }
    let message_version = if let Some(body) = body {
        identity(&body.message_id)?;
        verify_body_observation(body, observation)?;
        let metadata = if body.thinking.is_empty() {
            None
        } else {
            Some(serde_json::to_string(
                &json!({"thinking_blocks":[{"thinking":body.thinking}]}),
            )?)
        };
        if let Some(metadata) = metadata.as_ref() {
            ensure!(
                metadata.len() <= MAX_MESSAGE_METADATA_BYTES,
                "NIR1_GENERATION_MESSAGE_METADATA_LIMIT"
            );
        }
        let created = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms)
            .context("NIR1_GENERATION_TIME_MISMATCH")?
            .to_rfc3339();
        conn.execute(
            "INSERT INTO chat_messages(id,session_id,role,content,model,metadata,created_at)
            VALUES (?1,?2,'assistant',?3,?4,?5,?6)",
            params![
                body.message_id,
                &stored.session_id,
                body.content,
                &binding.model,
                metadata,
                created
            ],
        )?;
        Some(bind_message_in_tx(
            conn,
            &stored.project_id,
            &stored.session_id,
            &body.message_id,
            Some(id),
            now_ms,
        )?)
    } else {
        None
    };
    let failure_classification = if recovery {
        Some(FailureClassification::InterruptedUnknown)
    } else {
        match observation.terminal_status {
            TerminalStatus::Succeeded => None,
            TerminalStatus::Failed if observation.parse_status == ParseStatus::Invalid => {
                Some(FailureClassification::InvalidOutput)
            }
            TerminalStatus::Failed => Some(FailureClassification::DispatchUnavailable),
            TerminalStatus::Cancelled => Some(FailureClassification::Cancelled),
            TerminalStatus::Skipped => Some(FailureClassification::Skipped),
        }
    };
    let retry_classification = if failure_classification.is_some() {
        RetryClassification::NewAttemptRequired
    } else {
        RetryClassification::NotApplicable
    };
    let mut terminal = StoredTerminal {
        attempt_id: id.to_owned(),
        payload_digest: stored.payload_digest,
        input_digest: stored.input_digest,
        message_version,
        observation: serde_json::to_value(observation)?,
        failure_classification,
        retry_classification,
        completed_at_ms: now_ms,
        receipt_digest: String::new(),
    };
    terminal.receipt_digest = receipt_digest(&terminal)?;
    let terminal_json = canonical_json_string(&serde_json::to_value(&terminal)?)?;
    ensure!(
        terminal_json.len() <= MAX_TERMINAL_JSON_BYTES,
        "NIR1_GENERATION_TERMINAL_LIMIT"
    );
    ensure!(
        conn.execute(
            "UPDATE nir1_generation_attempts SET terminal_json=?2,terminal_digest=?3,
        completed_at_ms=?4,output_version_id=?5 WHERE id=?1 AND terminal_json IS NULL",
            params![
                id,
                terminal_json,
                terminal.receipt_digest,
                now_ms,
                terminal.message_version.as_ref().map(|v| v.id.as_str())
            ]
        )? == 1,
        "NIR1_GENERATION_TERMINAL_CONFLICT"
    );
    Ok(terminal)
}

fn verify_body_observation(body: &NewMessageBody, observation: &TerminalObservation) -> Result<()> {
    let mut observer = OutputObserver::new();
    observer.observe(OutputChannel::Text, body.content.as_bytes())?;
    observer.observe(OutputChannel::Thinking, body.thinking.as_bytes())?;
    let observed = observer.finish(Completion::ParseFailure);
    ensure!(
        observed.text_digest == observation.text_digest
            && observed.thinking_digest == observation.thinking_digest,
        "NIR1_GENERATION_OUTPUT_BODY_MISMATCH"
    );
    Ok(())
}

pub fn finish_attempt(
    db: &Database,
    id: &str,
    observation: &TerminalObservation,
    body: Option<NewMessageBody>,
    now_ms: i64,
) -> Result<StoredTerminal> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            finish_in_tx(conn, id, observation, body.as_ref(), now_ms, false)
        })
    })
}

/// Recovery owns one exact durable unfinished attempt. It never reconstructs a
/// transport request, resumes a claim, or asserts that no bytes were sent.
pub fn recover_attempt(db: &Database, id: &str, now_ms: i64) -> Result<StoredTerminal> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| recover_attempt_in_tx(conn, id, now_ms))
    })
}

fn recover_attempt_in_tx(conn: &Connection, id: &str, now_ms: i64) -> Result<StoredTerminal> {
    if let Some(terminal) = read_terminal_in_tx(conn, id)? {
        return Ok(terminal);
    }
    let failed = OutputObserver::new().finish(Completion::DispatchFailure);
    finish_in_tx(conn, id, &failed, None, now_ms, true)
}

/// Recover one existing attempt under the same participant-owned connection
/// scope as startup enumeration. A timeout or stop returns incomplete after
/// the scope rolls back and restores SQLite connection settings.
pub fn recover_attempt_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    id: &str,
    now_ms: i64,
    budget: ParticipantSqlOperationBudget,
) -> Result<StoredTerminal> {
    identity(id)?;
    workspace
        .authority
        .db()
        .with_participant_immediate_transaction_bounded(workspace.participant(), budget, |conn| {
            recover_attempt_in_tx(conn, id, now_ms)
        })
}

/// Exact ascending keyset page of projects with pending attempts in this workspace.
/// Filter before LIMIT so empty/terminal-only projects cannot starve fresh sweeps.
/// Startup recovery has no caller-selected project filter.
pub fn pending_project_id_page_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    after_id: Option<&str>,
    limit: usize,
    budget: ParticipantSqlOperationBudget,
) -> Result<Vec<String>> {
    ensure!(
        limit > 0 && limit <= MAX_RECOVERY_PAGE_SIZE,
        "NIR1_GENERATION_RECOVERY_INVALID_PAGE_SIZE"
    );
    if let Some(after_id) = after_id {
        identity(after_id)?;
    }
    workspace
        .authority
        .db()
        .with_participant_read_transaction_bounded(workspace.participant(), budget, |conn| {
            let mut statement = conn.prepare(
                "SELECT p.rowid,octet_length(p.id) FROM projects AS p
                 WHERE p.id>?1 AND EXISTS (
                     SELECT 1 FROM nir1_generation_attempts AS a
                     WHERE a.project_id=p.id AND a.terminal_json IS NULL
                 ) ORDER BY p.id LIMIT ?2",
            )?;
            let mut rows =
                statement.query(params![after_id.unwrap_or(""), i64::try_from(limit)?])?;
            let mut locations = Vec::new();
            while let Some(row) = rows.next()? {
                locations.push((
                    row.get::<_, i64>(0)?,
                    bounded_sqlite_length(
                        row.get::<_, i64>(1)?,
                        MAX_ID_BYTES,
                        "NIR1_GENERATION_PROJECT_METADATA_LIMIT",
                    )?,
                ));
            }
            drop(rows);
            let mut point = conn.prepare("SELECT id FROM projects WHERE rowid=?1")?;
            let mut result = Vec::with_capacity(locations.len());
            for (rowid, expected_bytes) in locations {
                let id: String = point.query_row([rowid], |row| row.get(0))?;
                identity(&id)?;
                ensure!(
                    id.len() == expected_bytes,
                    "NIR1_GENERATION_PROJECT_METADATA_CHANGED"
                );
                result.push(id);
            }
            Ok(result)
        })
}

/// Keyset pages are scoped before LIMIT. The recovery owner exhausts pages;
/// an empty global sample is never evidence that this project's work is absent.
pub fn pending_attempt_ids(
    db: &Database,
    project: &str,
    after_id: Option<&str>,
    limit: usize,
) -> Result<Vec<String>> {
    ensure!(limit > 0, "NIR1_GENERATION_INVALID_LIMIT");
    identity(project)?;
    if let Some(after_id) = after_id {
        identity(after_id)?;
    }
    db.with_read_transaction(|conn| pending_attempt_id_page_in_tx(conn, project, after_id, limit))
}

/// Bounded, participant-controlled pending-attempt page for restart recovery.
pub fn pending_attempt_id_page_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    project: &str,
    after_id: Option<&str>,
    limit: usize,
    budget: ParticipantSqlOperationBudget,
) -> Result<Vec<String>> {
    ensure!(
        limit > 0 && limit <= MAX_RECOVERY_PAGE_SIZE,
        "NIR1_GENERATION_RECOVERY_INVALID_PAGE_SIZE"
    );
    identity(project)?;
    if let Some(after_id) = after_id {
        identity(after_id)?;
    }
    workspace
        .authority
        .db()
        .with_participant_read_transaction_bounded(workspace.participant(), budget, |conn| {
            pending_attempt_id_page_in_tx(conn, project, after_id, limit)
        })
}

fn pending_attempt_id_page_in_tx(
    conn: &Connection,
    project: &str,
    after_id: Option<&str>,
    limit: usize,
) -> Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT rowid,octet_length(id) FROM nir1_generation_attempts
         WHERE project_id=?1 AND terminal_json IS NULL AND id>?2 ORDER BY id LIMIT ?3",
    )?;
    let mut rows = statement.query(params![
        project,
        after_id.unwrap_or(""),
        i64::try_from(limit)?
    ])?;
    let mut locations = Vec::new();
    while let Some(row) = rows.next()? {
        let rowid = row.get::<_, i64>(0)?;
        let id_length = bounded_sqlite_length(
            row.get::<_, i64>(1)?,
            MAX_ID_BYTES,
            "NIR1_GENERATION_ATTEMPT_METADATA_LIMIT",
        )?;
        locations.push((rowid, id_length));
    }
    drop(rows);
    let mut point = conn.prepare("SELECT id FROM nir1_generation_attempts WHERE rowid=?1")?;
    let mut result = Vec::with_capacity(locations.len());
    for (rowid, expected_bytes) in locations {
        let id: String = point.query_row([rowid], |row| row.get(0))?;
        identity(&id)?;
        ensure!(
            id.len() == expected_bytes,
            "NIR1_GENERATION_ATTEMPT_METADATA_CHANGED"
        );
        result.push(id);
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
