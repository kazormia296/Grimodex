//! Main-only AgentRun operations and the Native workspace owner lock.

use std::fs::File;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use grimodex_db::agent_runs::{
    self as db_runs, ActiveStatus, AnalysisReadBasisEntryV1, ApprovalDecision,
    ApprovalInvalidation, CapabilityState, ClaimAnswer, ClaimRequest, ExecutionState,
    FinalizingEvidence, FinalizingRun, InterruptReason, LedgerEntry, NotResumableReason,
    OpenApproval, OpenQuestion, RecoveryOutcome, RecoveryResult, ResumeGate, RunStart, RunState,
    RunStatus, TerminalOutcome, ToolCallUpdate,
};
use grimodex_db::{state::active_workspace_snapshot, Database};
use napi::Result;
use napi_derive::napi;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::{from_wire, run_blocking, Backend};

pub(super) struct WorkspaceOwner {
    path: PathBuf,
    id: String,
    _lock: File,
}

impl Backend {
    async fn agent_run_operation<P, T, F>(&self, payload: Value, operation: F) -> Result<String>
    where
        P: DeserializeOwned,
        T: Serialize,
        F: FnOnce(&Database, &WorkspaceOwner, P) -> anyhow::Result<T> + Send + 'static,
    {
        let state = Arc::clone(&self.state);
        let owner = Arc::clone(&self.agent_run_owner);
        run_blocking(move || {
            let payload = from_wire("payload", payload)?;
            // Keep the DB and its lock directory bound to the same lifecycle participant.
            let workspace = active_workspace_snapshot(&state.ws)?;
            let path = workspace.db().path();
            let mut owner = owner
                .lock()
                .map_err(|_| anyhow::anyhow!("AgentRun owner state lock poisoned"))?;
            if owner.as_ref().is_none_or(|current| current.path != path) {
                let id = uuid::Uuid::new_v4().to_string();
                let lock = db_runs::try_lock_owner(path, &id)?;
                *owner = Some(WorkspaceOwner {
                    path: path.to_path_buf(),
                    id,
                    _lock: lock,
                });
            }
            let owner = owner.as_ref().context("AgentRun owner not initialized")?;
            let result = operation(workspace.db().db(), owner, payload)?;
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }
}

fn row_owner(db: &Database, run_id: &str) -> anyhow::Result<String> {
    Ok(db_runs::get_run_status(db, run_id)?
        .context("AGENT_RUN_NOT_FOUND")?
        .execution_owner)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartPayload {
    run_id: String,
    project_id: String,
    chat_session_id: String,
    turn_id: String,
    route: String,
    origin_user_message_id: String,
    model_provider_id: String,
    model_id: String,
    endpoint_hash: String,
}

impl StartPayload {
    fn with_owner<'a>(&'a self, owner: &'a str) -> RunStart<'a> {
        RunStart {
            run_id: &self.run_id,
            project_id: &self.project_id,
            chat_session_id: &self.chat_session_id,
            turn_id: &self.turn_id,
            route: &self.route,
            origin_user_message_id: &self.origin_user_message_id,
            model_provider_id: &self.model_provider_id,
            model_id: &self.model_id,
            endpoint_hash: &self.endpoint_hash,
            execution_owner: owner,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SupersedingPayload {
    old_run_id: String,
    old_version: i64,
    new_run: StartPayload,
}

#[derive(Deserialize)]
#[serde(remote = "ActiveStatus", rename_all = "snake_case")]
enum ActiveStatusWire {
    Running,
    WaitingUser,
    WaitingApproval,
}

#[derive(Deserialize)]
#[serde(remote = "InterruptReason", rename_all = "snake_case")]
enum InterruptReasonWire {
    AppShutdown,
    RendererLost,
    WorkspaceSwitched,
    ProfileSwitched,
    QuestionTimeout,
    ApprovalTimeout,
}

#[derive(Deserialize)]
#[serde(remote = "TerminalOutcome", rename_all = "snake_case")]
enum TerminalOutcomeWire {
    Completed,
    LimitTokens,
    OutputTruncated,
    ContextWindowExceeded,
    ProviderError,
    RecordFailed,
    Timeout,
    UserStop,
    PolicyRevoked,
    LicenseRestricted,
    PermissionDenied,
    AuthorityLost,
    ResumeUnsupported,
    DiscardedByAuthor,
    SupersededByNewTurn,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InterruptPayload {
    run_id: String,
    #[serde(with = "ActiveStatusWire")]
    expected_status: ActiveStatus,
    version: i64,
    #[serde(with = "InterruptReasonWire")]
    reason: InterruptReason,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BeginFinalizingPayload {
    run_id: String,
    #[serde(with = "ActiveStatusWire")]
    expected_status: ActiveStatus,
    version: i64,
    #[serde(with = "TerminalOutcomeWire")]
    target: TerminalOutcome,
    assistant_message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunVersionPayload {
    run_id: String,
    version: i64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ClaimGatePayload {
    Allowed,
    Blocked { detail: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimAnswerPayload {
    interaction_id: String,
    interaction_version: i64,
    resolution: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimPayload {
    run_id: String,
    expected_version: i64,
    request_id: String,
    gate: ClaimGatePayload,
    answer: Option<ClaimAnswerPayload>,
}

#[derive(Deserialize)]
#[serde(remote = "LedgerEntry", rename_all = "camelCase", deny_unknown_fields)]
struct LedgerEntryWire {
    tool_call_id: String,
    name: String,
    canonical_args: Value,
    args_digest: String,
    execution_id: String,
    chat_message_id: String,
    main_owned_provenance_id: String,
    model: String,
    capability_state: CapabilityState,
    execution_state: ExecutionState,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppendToolCallPayload {
    run_id: String,
    #[serde(with = "LedgerEntryWire")]
    entry: LedgerEntry,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateToolCallPayload {
    run_id: String,
    tool_call_id: String,
    main_owned_provenance_id: Option<String>,
    capability_state: Option<CapabilityState>,
    execution_state: Option<ExecutionState>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointPayload {
    run_id: String,
    step: i64,
    checkpoint: Value,
    digest: String,
}

#[derive(Deserialize)]
#[serde(remote = "NotResumableReason", rename_all = "snake_case")]
enum NotResumableReasonWire {
    CheckpointWriteFailed,
    LedgerWriteFailed,
    HiddenSourceRead,
    RouteUnsupported,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NotResumablePayload {
    run_id: String,
    #[serde(with = "NotResumableReasonWire")]
    reason: NotResumableReason,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunIdPayload {
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenQuestionPayload {
    run_id: String,
    interaction_id: String,
    expected_version: i64,
    tool_call_id: String,
    args_digest: String,
    request: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnswerPayload {
    run_id: String,
    run_version: i64,
    interaction_id: String,
    interaction_version: i64,
    resolution: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenApprovalPayload {
    run_id: String,
    interaction_id: String,
    expected_version: i64,
    tool_call_id: String,
    tool_name: String,
    args_digest: String,
    request: String,
    target_basis: Option<Vec<AnalysisReadBasisEntryV1>>,
}

#[derive(Deserialize)]
#[serde(remote = "ApprovalDecision", rename_all = "snake_case")]
enum ApprovalDecisionWire {
    Approved,
    Rejected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecideApprovalPayload {
    run_id: String,
    run_version: i64,
    interaction_id: String,
    interaction_version: i64,
    #[serde(with = "ApprovalDecisionWire")]
    decision: ApprovalDecision,
}

#[derive(Deserialize)]
#[serde(remote = "ApprovalInvalidation", rename_all = "snake_case")]
enum ApprovalInvalidationWire {
    Superseded,
    Expired,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InvalidateApprovalPayload {
    run_id: String,
    run_version: i64,
    interaction_id: String,
    interaction_version: i64,
    #[serde(with = "ApprovalInvalidationWire")]
    invalidation: ApprovalInvalidation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvidencePayload {
    run_id: String,
    version: i64,
    user_message_complete: bool,
    assistant_message_complete: bool,
}

impl EvidencePayload {
    fn as_evidence(&self) -> FinalizingEvidence<'_> {
        FinalizingEvidence {
            run_id: &self.run_id,
            version: self.version,
            user_message_complete: self.user_message_complete,
            assistant_message_complete: self.assistant_message_complete,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoverPayload {
    min_activity_age_secs: Option<u32>,
    finalizing_evidence: Vec<EvidencePayload>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStateWire {
    run_id: String,
    version: i64,
    status: String,
}

impl From<RunState> for RunStateWire {
    fn from(state: RunState) -> Self {
        Self {
            run_id: state.run_id,
            version: state.version,
            status: state.status,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenInteractionWire {
    #[serde(flatten)]
    run: RunStateWire,
    interaction_version: i64,
}

impl From<RunState> for OpenInteractionWire {
    fn from(state: RunState) -> Self {
        Self {
            run: state.into(),
            interaction_version: 0,
        }
    }
}

#[derive(Serialize)]
struct SupersedingWire {
    discarded: RunStateWire,
    started: RunStateWire,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingApprovalWire {
    interaction_id: String,
    interaction_version: i64,
    tool_call_id: String,
    tool_name: String,
    args_digest: String,
    target_basis: Option<Vec<AnalysisReadBasisEntryV1>>,
}

#[derive(Serialize)]
#[serde(remote = "RecoveryOutcome", tag = "outcome", rename_all = "snake_case")]
enum RecoveryOutcomeWire {
    Interrupted,
    Finalized { status: String },
    NeedsStopMessageReplay,
    Skipped { reason: &'static str },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryWire {
    run_id: String,
    version: i64,
    #[serde(flatten, with = "RecoveryOutcomeWire")]
    outcome: RecoveryOutcome,
}

impl From<RecoveryResult> for RecoveryWire {
    fn from(result: RecoveryResult) -> Self {
        Self {
            run_id: result.run_id,
            version: result.version,
            outcome: result.outcome,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FinalizingWire {
    run_id: String,
    target_status: String,
    target_reason: String,
    origin_user_message_id: String,
    origin_assistant_message_id: String,
    version: i64,
}

impl From<FinalizingRun> for FinalizingWire {
    fn from(run: FinalizingRun) -> Self {
        Self {
            run_id: run.run_id,
            target_status: run.target_status,
            target_reason: run.target_reason,
            origin_user_message_id: run.origin_user_message_id,
            origin_assistant_message_id: run.origin_assistant_message_id,
            version: run.version,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStatusWire {
    run_id: String,
    project_id: String,
    chat_session_id: String,
    status: String,
    version: i64,
    resumable: bool,
    terminal_reason: Option<String>,
    interrupt_reason: Option<String>,
    not_resumable_reason: Option<String>,
    resume_block_detail: Option<String>,
    finalizing_target_reason: Option<String>,
}

impl From<RunStatus> for RunStatusWire {
    fn from(run: RunStatus) -> Self {
        Self {
            run_id: run.run_id,
            project_id: run.project_id,
            chat_session_id: run.chat_session_id,
            status: run.status,
            version: run.version,
            resumable: run.resumable,
            terminal_reason: run.terminal_reason,
            interrupt_reason: run.interrupt_reason,
            not_resumable_reason: run.not_resumable_reason,
            resume_block_detail: run.resume_block_detail,
            finalizing_target_reason: run.finalizing_target_reason,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyPayload {}

#[napi]
impl Backend {
    #[napi]
    pub async fn agent_run_start(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: StartPayload| {
            db_runs::start_run(db, &input.with_owner(&owner.id)).map(RunStateWire::from)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_start_superseding(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: SupersedingPayload| {
            let old_owner = row_owner(db, &input.old_run_id)?;
            let result = db_runs::start_superseding_run(
                db,
                &input.old_run_id,
                &old_owner,
                input.old_version,
                &input.new_run.with_owner(&owner.id),
            )?;
            Ok(SupersedingWire {
                discarded: result.discarded.into(),
                started: result.started.into(),
            })
        })
        .await
    }

    #[napi]
    pub async fn agent_run_interrupt(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: InterruptPayload| {
            db_runs::interrupt_run(
                db,
                &input.run_id,
                &owner.id,
                input.expected_status,
                input.version,
                input.reason,
            )
            .map(RunStateWire::from)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_begin_finalizing(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: BeginFinalizingPayload| {
            db_runs::begin_finalizing(
                db,
                &input.run_id,
                &owner.id,
                input.expected_status,
                input.version,
                input.target,
                &input.assistant_message_id,
            )
            .map(RunStateWire::from)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_finish_finalizing(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: RunVersionPayload| {
            db_runs::finish_finalizing(db, &input.run_id, &owner.id, input.version)
                .map(RunStateWire::from)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_discard(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, _, input: RunVersionPayload| {
            let owner = row_owner(db, &input.run_id)?;
            db_runs::discard_run(db, &input.run_id, &owner, input.version).map(RunStateWire::from)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_claim(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: ClaimPayload| {
            let old_owner = row_owner(db, &input.run_id)?;
            let gate = match &input.gate {
                ClaimGatePayload::Allowed => ResumeGate::Allowed,
                ClaimGatePayload::Blocked { detail } => ResumeGate::Blocked(detail),
            };
            let answer = input.answer.as_ref().map(|answer| ClaimAnswer {
                interaction_id: &answer.interaction_id,
                expected_version: answer.interaction_version,
                resolution: &answer.resolution,
            });
            let result = db_runs::claim_run(
                db,
                ClaimRequest {
                    run_id: &input.run_id,
                    old_owner: &old_owner,
                    new_owner: &owner.id,
                    expected_version: input.expected_version,
                    request_id: &input.request_id,
                    gate,
                    answer: answer.as_ref(),
                },
            )?;
            Ok(result.map(RunStateWire::from))
        })
        .await
    }

    #[napi]
    pub async fn agent_run_append_tool_call(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: AppendToolCallPayload| {
            db_runs::append_tool_call(db, &input.run_id, &owner.id, input.entry)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_update_tool_call(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: UpdateToolCallPayload| {
            db_runs::update_tool_call(
                db,
                ToolCallUpdate {
                    run_id: &input.run_id,
                    owner: &owner.id,
                    tool_call_id: &input.tool_call_id,
                    main_owned_provenance_id: input.main_owned_provenance_id.as_deref(),
                    capability_state: input.capability_state,
                    execution_state: input.execution_state,
                },
            )
        })
        .await
    }

    #[napi]
    pub async fn agent_run_write_checkpoint(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: CheckpointPayload| {
            db_runs::write_checkpoint(
                db,
                &input.run_id,
                &owner.id,
                input.step,
                &input.checkpoint,
                &input.digest,
            )
        })
        .await
    }

    #[napi]
    pub async fn agent_run_mark_not_resumable(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: NotResumablePayload| {
            db_runs::mark_not_resumable(db, &input.run_id, &owner.id, input.reason)
                .map(RunStateWire::from)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_touch_activity(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: RunIdPayload| {
            db_runs::touch_activity(db, &input.run_id, &owner.id)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_open_question(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: OpenQuestionPayload| {
            db_runs::open_user_question(
                db,
                &OpenQuestion {
                    run_id: &input.run_id,
                    interaction_id: &input.interaction_id,
                    owner: &owner.id,
                    expected_version: input.expected_version,
                    tool_call_id: &input.tool_call_id,
                    args_digest: &input.args_digest,
                    request: &input.request,
                },
            )
            .map(OpenInteractionWire::from)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_answer(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: AnswerPayload| {
            db_runs::answer_live(
                db,
                &input.run_id,
                &owner.id,
                input.run_version,
                &input.interaction_id,
                input.interaction_version,
                &input.resolution,
            )
            .map(RunStateWire::from)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_open_approval(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: OpenApprovalPayload| {
            db_runs::open_approval(
                db,
                &OpenApproval {
                    run_id: &input.run_id,
                    interaction_id: &input.interaction_id,
                    owner: &owner.id,
                    expected_version: input.expected_version,
                    tool_call_id: &input.tool_call_id,
                    tool_name: &input.tool_name,
                    args_digest: &input.args_digest,
                    request: &input.request,
                    target_basis: input.target_basis.as_deref(),
                },
            )
            .map(OpenInteractionWire::from)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_decide_approval(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: DecideApprovalPayload| {
            db_runs::decide_approval(
                db,
                &input.run_id,
                &owner.id,
                input.run_version,
                &input.interaction_id,
                input.interaction_version,
                input.decision,
            )
            .map(RunStateWire::from)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_invalidate_approval(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: InvalidateApprovalPayload| {
            db_runs::invalidate_approval(
                db,
                &input.run_id,
                &owner.id,
                input.run_version,
                &input.interaction_id,
                input.interaction_version,
                input.invalidation,
            )
            .map(RunStateWire::from)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_get_pending_approval(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, _, input: RunIdPayload| {
            Ok(
                db_runs::get_pending_approval(db, &input.run_id)?.map(|pending| {
                    PendingApprovalWire {
                        interaction_id: pending.interaction_id,
                        interaction_version: pending.version,
                        tool_call_id: pending.tool_call_id,
                        tool_name: pending.tool_name,
                        args_digest: pending.args_digest,
                        target_basis: pending.target_basis,
                    }
                }),
            )
        })
        .await
    }

    #[napi]
    pub async fn agent_run_recover(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: RecoverPayload| {
            let evidence: Vec<_> = input
                .finalizing_evidence
                .iter()
                .map(EvidencePayload::as_evidence)
                .collect();
            let mut recovered = Vec::new();
            for old_owner in db_runs::list_nonterminal_owners(db)? {
                if old_owner != owner.id {
                    let results = db_runs::recover_owner(
                        db,
                        &owner.path,
                        &old_owner,
                        input.min_activity_age_secs,
                        &evidence,
                    )?;
                    recovered.extend(results.into_iter().map(RecoveryWire::from));
                }
            }
            Ok(recovered)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_recover_finalizing(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, owner, input: EvidencePayload| {
            db_runs::recover_finalizing(db, &owner.id, &input.as_evidence()).map(RecoveryWire::from)
        })
        .await
    }

    #[napi]
    pub async fn agent_run_list_finalizing(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, _, _: EmptyPayload| {
            Ok(db_runs::list_finalizing(db)?
                .into_iter()
                .map(FinalizingWire::from)
                .collect::<Vec<_>>())
        })
        .await
    }

    #[napi]
    pub async fn agent_run_get_status(&self, payload: Value) -> Result<String> {
        self.agent_run_operation(payload, |db, _, input: RunIdPayload| {
            Ok(db_runs::get_run_status(db, &input.run_id)?.map(RunStatusWire::from))
        })
        .await
    }
}
