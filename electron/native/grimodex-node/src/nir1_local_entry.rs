//! The Native entry of the NIR-1 local generation route (K5/3 "IPC の
//! command"; DD-1a, `docs/plans/nir1-lane-decisions/dd1a-decisions.md`).
//!
//! Six commands, each behind the closed-by-default Native gate
//! (`PrePublicationEntry::LocalGeneration`, DR-DD1A-2):
//!
//! - `generation_start`: the checks before DT-2's `capture` (the list in the
//!   decisions record; a start refused there is not recorded and can be
//!   pressed again), the start record of the capture, DT-2's `capture`, the AI
//!   use policy read before the attempt (`check_before_attempt`), then the
//!   handle. The rest (D-final preparation, create, re-observation, claim and
//!   the DT-5 transport) runs on a plain `nir1-local-starter` thread, so the
//!   handle exists before the create and a cancel reaches every stage
//!   (DR-DD1A-6). The answer is an opaque handle or a typed unavailable.
//! - `generation_continue`: the started run's new text and thinking, bounded,
//!   only for the exact caller that started it (DR-DD1A-7, DR-DD1A-8).
//! - `generation_cancel`: the owner's `cancel()` and then the existing capture
//!   writer, in one command (K4/3; DR-DD1A-9).
//! - `conversation_create`／`_list`／`_read`: the conversations of this route
//!   (S20; DR-DD1A-3, DR-DD1A-10, DR-DD1A-11).
//!
//! Locks: the handle table and the start record are short mutexes held only to
//! change the table; no database call, owner lock or lease is taken under
//! them. Output leaves only through `generation_continue`; nothing is
//! broadcast.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use grimodex_ai::AiProvider;
use grimodex_core::nir1_local_send_policy::{
    Nir1LocalSendPolicyBasis, Nir1LocalSendPolicyDenial, Nir1LocalSendPurpose,
};
use grimodex_db::nir1_generation::local_conversation::{
    self as conversations, LocalConversationEntry, LocalConversationRead, LocalConversationRowKind,
    LocalConversationScope, NIR1_LOCAL_CONVERSATION_PAGE_BYTES, NIR1_LOCAL_CONVERSATION_PAGE_ROWS,
};
use grimodex_db::nir1_generation::{GenerationPurpose, Nir1StoreFailure};
use grimodex_db::workspace_lifecycle::LiveBinding;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::main_grant::PrePublicationEntry;
use crate::nir1_generation_owner::{Nir1GenerationRefusal, Nir1OwnerCancel, Nir1Settlement};
use crate::nir1_local_attempt::{
    Nir1LocalAttempt, Nir1LocalAttemptOutcome, Nir1LocalAttemptRefusal,
};
use crate::nir1_local_send_policy::{
    check_before_attempt, Nir1LocalSendPolicyOutcome, Nir1LocalSendPolicyRefusal,
};
use crate::nir1_local_transport::{
    start_local_generation, Nir1LocalGenerationInput, Nir1LocalRun, Nir1LocalRunState,
    Nir1LocalTransportConfig,
};
use crate::nir1_prepared_request::{
    self as prepared, CancelCurrentChatInputRequest, LocalGenerationIntent, MainKeyVerdict,
    NativeAcceptedChatSubmission, UnsupportedInputIntent, LOCAL_CHAT_API,
};
use crate::profile_egress::CallerIdentity;
use crate::state::AppState;

/// Handles alive at once (running plus final but not yet drained). Equal to
/// DT-2's tracked-session bound (`NIR1_GENERATION_MAX_TRACKED_SESSIONS`).
pub(crate) const NIR1_LOCAL_HANDLE_LIMIT: usize = 16;
/// How long a final handle that was never drained is kept before the next
/// start removes it.
pub(crate) const NIR1_LOCAL_FINAL_RETENTION: Duration = Duration::from_secs(60);
/// The most text bytes, and separately the most thinking bytes, one continue
/// returns (DR-DD1A-8).
pub(crate) const NIR1_LOCAL_CONTINUE_MAX_BYTES: usize = 64 * 1024;
/// Chat sessions the start record remembers (DR-DD1A-4).
pub(crate) const NIR1_LOCAL_START_RECORD_LIMIT: usize = 4096;
/// The longest ID a command accepts (the IPC contract's bound for chat IDs).
const MAX_WIRE_ID_BYTES: usize = 256;

const _: () = assert!(
    NIR1_LOCAL_HANDLE_LIMIT == crate::nir1_generation_owner::NIR1_GENERATION_MAX_TRACKED_SESSIONS
);

// ---------------------------------------------------------------------------
// Typed refusals.
// ---------------------------------------------------------------------------

/// Every closed reason a command returns. Codes only: no text, ID or value
/// reaches a reason.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Nir1LocalRefusal {
    GateClosed,
    RequestInvalid,
    ProfileNotAdmitted,
    WorkspaceNotReady,
    KeyPresent,
    KeyCheckFailed,
    StartupGateClosed,
    NotThisRoute,
    ConversationMissing,
    PurposeMismatch,
    SceneMismatch,
    CaptureNotCurrent,
    HandleCapacity,
    StartRecordFull,
    AlreadyStarted,
    SessionBusy,
    SameSubmissionInFlight,
    SessionUnresolved,
    AlreadyAttempted,
    InFlightCapacity,
    ProfileRevoked,
    RouteChanged,
    Cancelled,
    OwnerRefused,
    PreparationFailed,
    PolicyDenied,
    PolicyUnreadable,
    StarterUnavailable,
    HandleNotFound,
    CallerRevoked,
    CancelCaptureFailed,
    ConversationRowLimit,
    Unavailable,
}

impl Nir1LocalRefusal {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::GateClosed => "NIR1_LOCAL_GATE_CLOSED",
            Self::RequestInvalid => "NIR1_LOCAL_REQUEST_INVALID",
            Self::ProfileNotAdmitted => "NIR1_LOCAL_PROFILE_NOT_ADMITTED",
            Self::WorkspaceNotReady => "NIR1_LOCAL_WORKSPACE_NOT_READY",
            Self::KeyPresent => "NIR1_LOCAL_KEY_PRESENT",
            Self::KeyCheckFailed => "NIR1_LOCAL_KEY_CHECK_FAILED",
            Self::StartupGateClosed => "NIR1_LOCAL_STARTUP_GATE_CLOSED",
            Self::NotThisRoute => "NIR1_LOCAL_NOT_THIS_ROUTE",
            Self::ConversationMissing => "NIR1_LOCAL_CONVERSATION_MISSING",
            Self::PurposeMismatch => "NIR1_LOCAL_PURPOSE_MISMATCH",
            Self::SceneMismatch => "NIR1_LOCAL_SCENE_MISMATCH",
            Self::CaptureNotCurrent => "NIR1_LOCAL_CAPTURE_NOT_CURRENT",
            Self::HandleCapacity => "NIR1_LOCAL_HANDLE_CAPACITY",
            Self::StartRecordFull => "NIR1_LOCAL_START_RECORD_FULL",
            Self::AlreadyStarted => "NIR1_LOCAL_ALREADY_STARTED",
            Self::SessionBusy => "NIR1_LOCAL_SESSION_BUSY",
            Self::SameSubmissionInFlight => "NIR1_LOCAL_SAME_SUBMISSION_IN_FLIGHT",
            Self::SessionUnresolved => "NIR1_LOCAL_SESSION_UNRESOLVED",
            Self::AlreadyAttempted => "NIR1_LOCAL_ALREADY_ATTEMPTED",
            Self::InFlightCapacity => "NIR1_LOCAL_IN_FLIGHT_CAPACITY",
            Self::ProfileRevoked => "NIR1_LOCAL_PROFILE_REVOKED",
            Self::RouteChanged => "NIR1_LOCAL_ROUTE_CHANGED",
            Self::Cancelled => "NIR1_LOCAL_CANCELLED",
            Self::OwnerRefused => "NIR1_LOCAL_OWNER_REFUSED",
            Self::PreparationFailed => "NIR1_LOCAL_PREPARATION_FAILED",
            Self::PolicyDenied => "NIR1_LOCAL_POLICY_DENIED",
            Self::PolicyUnreadable => "NIR1_LOCAL_POLICY_UNREADABLE",
            Self::StarterUnavailable => "NIR1_LOCAL_STARTER_UNAVAILABLE",
            Self::HandleNotFound => "NIR1_LOCAL_HANDLE_NOT_FOUND",
            Self::CallerRevoked => "NIR1_LOCAL_CALLER_REVOKED",
            Self::CancelCaptureFailed => "NIR1_LOCAL_CANCEL_CAPTURE_FAILED",
            Self::ConversationRowLimit => "NIR1_LOCAL_CONVERSATION_ROW_LIMIT",
            Self::Unavailable => "NIR1_LOCAL_UNAVAILABLE",
        }
    }
}

/// A refusal of the workspace and caller check: the profile gate's errors
/// carry the D2a marker; the rest are workspace states.
fn workspace_refusal(error: &anyhow::Error) -> Nir1LocalRefusal {
    let message = format!("{error:#}");
    if message.contains(crate::profile_egress::D2A_EGRESS_DENIED_MARKER) {
        Nir1LocalRefusal::ProfileNotAdmitted
    } else if message.contains("NIR1_PREPARED_WORKSPACE") {
        Nir1LocalRefusal::WorkspaceNotReady
    } else {
        Nir1LocalRefusal::Unavailable
    }
}

fn owner_refusal(refusal: &Nir1GenerationRefusal) -> Nir1LocalRefusal {
    match refusal {
        Nir1GenerationRefusal::WorkspaceNotReady | Nir1GenerationRefusal::WorkspaceUnavailable => {
            Nir1LocalRefusal::WorkspaceNotReady
        }
        Nir1GenerationRefusal::GateClosed => Nir1LocalRefusal::StartupGateClosed,
        Nir1GenerationRefusal::ProfileRevoked => Nir1LocalRefusal::ProfileRevoked,
        Nir1GenerationRefusal::RouteChanged => Nir1LocalRefusal::RouteChanged,
        Nir1GenerationRefusal::Cancelled => Nir1LocalRefusal::Cancelled,
        Nir1GenerationRefusal::SubmissionNotCurrent => Nir1LocalRefusal::CaptureNotCurrent,
        Nir1GenerationRefusal::SameSubmissionInFlight { .. } => {
            Nir1LocalRefusal::SameSubmissionInFlight
        }
        Nir1GenerationRefusal::SessionBusy => Nir1LocalRefusal::SessionBusy,
        Nir1GenerationRefusal::SessionUnresolved { .. } => Nir1LocalRefusal::SessionUnresolved,
        Nir1GenerationRefusal::SubmissionAlreadyAttempted { .. } => {
            Nir1LocalRefusal::AlreadyAttempted
        }
        Nir1GenerationRefusal::InFlightCapacity => Nir1LocalRefusal::InFlightCapacity,
        _ => Nir1LocalRefusal::OwnerRefused,
    }
}

fn attempt_refusal(refusal: &Nir1LocalAttemptRefusal) -> Nir1LocalRefusal {
    match refusal {
        Nir1LocalAttemptRefusal::Owner(refusal) => owner_refusal(refusal),
        Nir1LocalAttemptRefusal::Prepare(error) => {
            let message = format!("{error:#}");
            if message.contains("NIR1_PREPARED_KEY_PRESENT") {
                Nir1LocalRefusal::KeyPresent
            } else if message.contains("NIR1_PREPARED_KEY_CHECK_FAILED") {
                Nir1LocalRefusal::KeyCheckFailed
            } else {
                Nir1LocalRefusal::PreparationFailed
            }
        }
        Nir1LocalAttemptRefusal::Assembly(_) => Nir1LocalRefusal::PreparationFailed,
    }
}

// ---------------------------------------------------------------------------
// Wire forms. Strict: unknown fields are refused; nothing selects a route,
// endpoint, message, policy result or transport.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Nir1LocalPurposeWire {
    Writing,
    Review,
}

impl Nir1LocalPurposeWire {
    fn generation(self) -> GenerationPurpose {
        match self {
            Self::Writing => GenerationPurpose::Writing,
            Self::Review => GenerationPurpose::Review,
        }
    }
}

fn send_purpose(purpose: &GenerationPurpose) -> Nir1LocalSendPurpose {
    match purpose {
        GenerationPurpose::Writing => Nir1LocalSendPurpose::Writing,
        GenerationPurpose::Review => Nir1LocalSendPurpose::Review,
    }
}

fn purpose_word(purpose: &GenerationPurpose) -> &'static str {
    match purpose {
        GenerationPurpose::Writing => "writing",
        GenerationPurpose::Review => "review",
    }
}

/// The renderer's typed intent, as Main validated it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Nir1LocalGenerationStartIntent {
    pub(crate) purpose: Nir1LocalPurposeWire,
    pub(crate) conversation_id: String,
    pub(crate) scene_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Nir1LocalKeyVerdictWire {
    Absent,
    Present,
    CheckFailed,
}

/// Main's key verdict for the active endpoint, decided when the generation
/// starts (K5/3 必須防御 4; Main's side is DD-1b).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Nir1LocalMainKeyVerdict {
    pub(crate) endpoint_id: String,
    pub(crate) key_verdict: Nir1LocalKeyVerdictWire,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Nir1LocalHandleRequest {
    pub(crate) handle: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Nir1LocalConversationCreateRequest {
    pub(crate) purpose: Nir1LocalPurposeWire,
    pub(crate) scene_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Nir1LocalConversationReadRequest {
    pub(crate) conversation_id: String,
    pub(crate) offset: u32,
    pub(crate) limit: u32,
}

fn wire_id(value: &str) -> Result<(), Nir1LocalRefusal> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > MAX_WIRE_ID_BYTES
        || value.chars().any(char::is_control)
    {
        Err(Nir1LocalRefusal::RequestInvalid)
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Responses.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Eq, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub(crate) enum Nir1LocalStartResponse {
    Started { handle: String },
    Unavailable { reason: &'static str },
}

#[derive(Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Nir1LocalDeltaView {
    pub(crate) text: String,
    pub(crate) thinking: String,
    /// `starting`, `running`, `succeeded`, `failed` or `cancelled`.
    pub(crate) state: &'static str,
    /// A closed word once the state is final.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<&'static str>,
    /// The run is final and nothing is left; the handle is gone.
    pub(crate) drained: bool,
}

#[derive(Debug, Serialize, Eq, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub(crate) enum Nir1LocalContinueResponse {
    Ok(Nir1LocalDeltaView),
    Refused { reason: &'static str },
}

#[derive(Debug, Serialize, Eq, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub(crate) enum Nir1LocalCancelResponse {
    Ok,
    Refused { reason: &'static str },
}

#[derive(Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Nir1LocalDisplayName {
    pub(crate) purpose: &'static str,
    pub(crate) created_at: Option<String>,
}

#[derive(Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Nir1LocalConversationView {
    pub(crate) conversation_id: String,
    pub(crate) display_name: Nir1LocalDisplayName,
}

impl From<LocalConversationEntry> for Nir1LocalConversationView {
    fn from(entry: LocalConversationEntry) -> Self {
        Self {
            display_name: Nir1LocalDisplayName {
                purpose: purpose_word(&entry.purpose),
                created_at: entry.created_at,
            },
            conversation_id: entry.id,
        }
    }
}

#[derive(Debug, Serialize, Eq, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub(crate) enum Nir1LocalCreateResponse {
    Created(Nir1LocalConversationView),
    Refused { reason: &'static str },
}

#[derive(Debug, Serialize, Eq, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub(crate) enum Nir1LocalListResponse {
    #[serde(rename_all = "camelCase")]
    Ok {
        conversations: Vec<Nir1LocalConversationView>,
        truncated: bool,
    },
    Refused {
        reason: &'static str,
    },
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Nir1LocalRowView {
    pub(crate) message_id: String,
    /// `input` or `output`.
    pub(crate) kind: &'static str,
    pub(crate) created_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) thinking: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) attempt_status: Option<String>,
    /// A row of stage (a) or (b) that failed its verification: no content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) unavailable: Option<&'static str>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub(crate) enum Nir1LocalReadResponse {
    #[serde(rename_all = "camelCase")]
    Ok {
        purpose: &'static str,
        rows: Vec<Nir1LocalRowView>,
        total: usize,
        truncated: bool,
    },
    Refused {
        reason: &'static str,
    },
}

// ---------------------------------------------------------------------------
// Process-local state.
// ---------------------------------------------------------------------------

enum Phase {
    /// The starter thread owns the attempt (prepare, create, claim).
    Starting,
    Running(Nir1LocalRun),
    /// The attempt never reached a transport.
    Ended {
        state: Nir1LocalRunState,
        reason: &'static str,
    },
}

struct HandleEntry {
    handle: String,
    caller: CallerIdentity,
    submission: NativeAcceptedChatSubmission,
    /// The owner's cancel handle (the same control the run's handle uses).
    cancel: Nir1OwnerCancel,
    phase: Mutex<Phase>,
    final_since: Mutex<Option<Instant>>,
    /// The user withdrew this generation (`generation_cancel` was called).
    withdrawn: AtomicBool,
    /// The capture writer of a withdrawal reached its terminal result.
    capture_settled: AtomicBool,
}

impl HandleEntry {
    fn lock_phase(&self) -> MutexGuard<'_, Phase> {
        self.phase.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set_phase(&self, phase: Phase) {
        *self.lock_phase() = phase;
    }

    /// Whether the generation is over (a durable terminal, or no attempt).
    fn is_final(&self) -> bool {
        match &*self.lock_phase() {
            Phase::Starting => false,
            Phase::Running(run) => run.state().is_final(),
            Phase::Ended { .. } => true,
        }
    }

    /// A withdrawal whose capture writer has not reached its terminal result
    /// keeps the handle, so the same cancel can be retried (K4/3).
    fn withdrawal_pending(&self) -> bool {
        self.withdrawn.load(Ordering::Acquire) && !self.capture_settled.load(Ordering::Acquire)
    }

    fn final_for_longer_than(&self, retention: Duration, now: Instant) -> bool {
        if !self.is_final() {
            return false;
        }
        let mut since = self
            .final_since
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let started = *since.get_or_insert(now);
        now.duration_since(started) >= retention
    }
}

#[derive(Default)]
struct HandleTable {
    entries: Vec<Arc<HandleEntry>>,
    reserved: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StartKey {
    binding: LiveBinding,
    project_id: String,
    chat_session_id: String,
}

#[derive(Default)]
struct StartRecords {
    /// The capture of each session whose start was recorded last.
    entries: Vec<(StartKey, String)>,
}

/// Test-only hooks of the entry.
#[cfg(test)]
pub(crate) mod test_hooks {
    use super::*;
    use crate::nir1_generation_owner::test_hooks::Nir1OwnerTestHooks;
    use crate::nir1_local_attempt::Nir1LocalAttemptProbe;

    pub(crate) type AttemptProbe = Arc<dyn Fn(Nir1LocalAttemptProbe) + Send + Sync>;
    /// Arms the owner's own test hooks (probes, failpoints) right after DT-2's
    /// capture.
    pub(crate) type OwnerSetup = Arc<dyn Fn(&Nir1OwnerTestHooks) + Send + Sync>;
    pub(crate) type StartProbe = Arc<dyn Fn() + Send + Sync>;

    #[derive(Default)]
    pub(crate) struct Nir1LocalEntryTestHooks {
        pub(crate) transport_config: Option<Nir1LocalTransportConfig>,
        pub(crate) attempt_probe: Option<AttemptProbe>,
        pub(crate) owner_setup: Option<OwnerSetup>,
        /// Runs right after the start record is placed, before DT-2's capture.
        pub(crate) after_start_record: Option<StartProbe>,
        /// Runs right after DT-2's capture, before the policy read.
        pub(crate) after_owner_capture: Option<StartProbe>,
    }
}

#[derive(Default)]
pub(crate) struct Nir1LocalEntryState {
    handles: Mutex<HandleTable>,
    starts: Mutex<StartRecords>,
    #[cfg(test)]
    hooks: Mutex<Option<Arc<test_hooks::Nir1LocalEntryTestHooks>>>,
}

impl Nir1LocalEntryState {
    fn handles(&self) -> MutexGuard<'_, HandleTable> {
        self.handles.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn starts(&self) -> MutexGuard<'_, StartRecords> {
        self.starts.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(test)]
    pub(crate) fn set_test_hooks(&self, hooks: test_hooks::Nir1LocalEntryTestHooks) {
        *self.hooks.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(hooks));
    }

    #[cfg(test)]
    fn test_hooks(&self) -> Option<Arc<test_hooks::Nir1LocalEntryTestHooks>> {
        self.hooks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    #[cfg(test)]
    pub(crate) fn handle_count(&self) -> usize {
        self.handles().entries.len()
    }

    #[cfg(test)]
    pub(crate) fn start_record_count(&self) -> usize {
        self.starts().entries.len()
    }

    /// Reserve one handle slot, pruning final handles past the retention.
    fn reserve_handle(self: &Arc<Self>) -> Result<HandleReservation, Nir1LocalRefusal> {
        let mut table = self.handles();
        let now = Instant::now();
        table
            .entries
            .retain(|entry| !entry.final_for_longer_than(NIR1_LOCAL_FINAL_RETENTION, now));
        if table.entries.len() + table.reserved >= NIR1_LOCAL_HANDLE_LIMIT {
            return Err(Nir1LocalRefusal::HandleCapacity);
        }
        table.reserved += 1;
        Ok(HandleReservation {
            state: Arc::clone(self),
            armed: true,
        })
    }

    /// Place the start record of `capture_id` for the session (DR-DD1A-4).
    /// A capture whose start was already recorded is refused, wherever its
    /// first start ended.
    fn record_start(&self, key: StartKey, capture_id: &str) -> Result<(), Nir1LocalRefusal> {
        let mut records = self.starts();
        if let Some((_, recorded)) = records
            .entries
            .iter_mut()
            .find(|(current, _)| *current == key)
        {
            if recorded == capture_id {
                return Err(Nir1LocalRefusal::AlreadyStarted);
            }
            capture_id.clone_into(recorded);
            return Ok(());
        }
        if records.entries.len() >= NIR1_LOCAL_START_RECORD_LIMIT {
            // A session of another Ready entry can no longer use its capture
            // (the owner's workspace incarnation differs), so its record can go.
            records
                .entries
                .retain(|(current, _)| current.binding == key.binding);
            if records.entries.len() >= NIR1_LOCAL_START_RECORD_LIMIT {
                return Err(Nir1LocalRefusal::StartRecordFull);
            }
        }
        records.entries.push((key, capture_id.to_owned()));
        Ok(())
    }

    /// The handle's entry, only for the exact caller that started it. A
    /// missing handle and another caller's handle look the same.
    fn entry_for(&self, handle: &str, caller: &CallerIdentity) -> Option<Arc<HandleEntry>> {
        self.handles()
            .entries
            .iter()
            .find(|entry| entry.handle == handle && entry.caller == *caller)
            .cloned()
    }

    fn remove(&self, handle: &str) {
        self.handles()
            .entries
            .retain(|entry| entry.handle != handle);
    }
}

struct HandleReservation {
    state: Arc<Nir1LocalEntryState>,
    armed: bool,
}

impl HandleReservation {
    fn commit(mut self, entry: Arc<HandleEntry>) {
        self.armed = false;
        let mut table = self.state.handles();
        table.reserved -= 1;
        table.entries.push(entry);
    }
}

impl Drop for HandleReservation {
    fn drop(&mut self) {
        if self.armed {
            self.state.handles().reserved -= 1;
        }
    }
}

fn gate_open(state: &AppState) -> bool {
    state
        .main_grant
        .gate
        .is_open(PrePublicationEntry::LocalGeneration)
}

// ---------------------------------------------------------------------------
// nir1_local_generation_start
// ---------------------------------------------------------------------------

/// What the checks before DT-2's `capture` established.
struct Admitted {
    binding: LiveBinding,
    project_id: String,
    purpose: GenerationPurpose,
    submission: NativeAcceptedChatSubmission,
    intent: LocalGenerationIntent,
    scene_id: String,
}

/// The checks before DT-2's `capture`, in the recorded order (1 to 7; 8 and 9
/// follow in the caller). A refusal here is not recorded.
fn admit_start(
    state: &Arc<AppState>,
    caller: &CallerIdentity,
    intent: &Nir1LocalGenerationStartIntent,
    verdict: &Nir1LocalMainKeyVerdict,
) -> Result<Admitted, Nir1LocalRefusal> {
    // 1. The Native gate.
    if !gate_open(state) {
        return Err(Nir1LocalRefusal::GateClosed);
    }
    // 2. The shape.
    wire_id(&intent.conversation_id)?;
    wire_id(&intent.scene_id)?;
    wire_id(&verdict.endpoint_id)?;
    let purpose = intent.purpose.generation();
    // 3. The profile and the caller.
    let (workspace, binding) = prepared::ready_workspace_for_caller(state, caller)
        .map_err(|error| workspace_refusal(&error))?;
    // 4. Main's key verdict.
    let key_verdict = match verdict.key_verdict {
        Nir1LocalKeyVerdictWire::Absent => MainKeyVerdict::Absent,
        Nir1LocalKeyVerdictWire::Present => return Err(Nir1LocalRefusal::KeyPresent),
        Nir1LocalKeyVerdictWire::CheckFailed => return Err(Nir1LocalRefusal::KeyCheckFailed),
    };
    let generation =
        LocalGenerationIntent::new(purpose.clone(), key_verdict, verdict.endpoint_id.clone());
    // 5. The startup gate of this Ready entry (peeked: the lease is dropped).
    if state
        .workspace_lifecycle
        .nir1_startup_gate()
        .try_lease_for_binding(&binding)
        .is_none()
    {
        return Err(Nir1LocalRefusal::StartupGateClosed);
    }
    // 6. The session stage, the purpose and the Scene.
    let scope = conversations::read_local_conversation_scope_bounded(
        &workspace,
        &intent.conversation_id,
        prepared::participant_sql_budget(),
    )
    .map_err(|_| Nir1LocalRefusal::Unavailable)?;
    drop(workspace);
    let project_id = match scope {
        LocalConversationScope::NotThisRoute => return Err(Nir1LocalRefusal::NotThisRoute),
        LocalConversationScope::Missing => return Err(Nir1LocalRefusal::ConversationMissing),
        LocalConversationScope::NoScene => return Err(Nir1LocalRefusal::SceneMismatch),
        LocalConversationScope::Scene {
            purpose: marked,
            project_id,
            scene_id,
        } => {
            if marked != purpose {
                return Err(Nir1LocalRefusal::PurposeMismatch);
            }
            if scene_id != intent.scene_id {
                return Err(Nir1LocalRefusal::SceneMismatch);
            }
            project_id
        }
    };
    // 7. The conversation's current capture, owned by this caller.
    let submission = prepared::current_submission_for_session(
        state,
        caller,
        &intent.conversation_id,
        &intent.scene_id,
    )
    .map_err(|error| workspace_refusal(&error))?
    .ok_or(Nir1LocalRefusal::CaptureNotCurrent)?;
    if submission.project_id() != project_id {
        return Err(Nir1LocalRefusal::CaptureNotCurrent);
    }
    Ok(Admitted {
        binding,
        project_id,
        purpose,
        submission,
        intent: generation,
        scene_id: intent.scene_id.clone(),
    })
}

fn policy_refusal(refusal: &Nir1LocalSendPolicyRefusal) -> Nir1LocalRefusal {
    match refusal {
        Nir1LocalSendPolicyRefusal::Policy(Nir1LocalSendPolicyDenial::ItemDisabled(_)) => {
            Nir1LocalRefusal::PolicyDenied
        }
        Nir1LocalSendPolicyRefusal::ReadFailed(Nir1StoreFailure::Cancelled) => {
            Nir1LocalRefusal::Cancelled
        }
        _ => Nir1LocalRefusal::PolicyUnreadable,
    }
}

/// Start one generation (K5/3 "IPC の command" 生成の開始).
pub(crate) fn generation_start(
    state: &Arc<AppState>,
    caller: CallerIdentity,
    intent: Nir1LocalGenerationStartIntent,
    verdict: Nir1LocalMainKeyVerdict,
) -> Nir1LocalStartResponse {
    match start_inner(state, caller, intent, verdict) {
        Ok(handle) => Nir1LocalStartResponse::Started { handle },
        Err(refusal) => Nir1LocalStartResponse::Unavailable {
            reason: refusal.code(),
        },
    }
}

fn start_inner(
    state: &Arc<AppState>,
    caller: CallerIdentity,
    intent: Nir1LocalGenerationStartIntent,
    verdict: Nir1LocalMainKeyVerdict,
) -> Result<String, Nir1LocalRefusal> {
    let admitted = admit_start(state, &caller, &intent, &verdict)?;
    // 8. A handle slot, held until the handle is registered.
    let reservation = state.nir1_local_entry.reserve_handle()?;
    // 9. The start record, placed before DT-2's capture. From here on, the
    // same capture cannot be started again.
    state.nir1_local_entry.record_start(
        StartKey {
            binding: admitted.binding.clone(),
            project_id: admitted.project_id.clone(),
            chat_session_id: admitted.submission.chat_session_id().to_owned(),
        },
        admitted.submission.capture_id(),
    )?;
    #[cfg(test)]
    let hooks = state.nir1_local_entry.test_hooks();
    #[cfg(test)]
    if let Some(probe) = hooks
        .as_ref()
        .and_then(|hooks| hooks.after_start_record.clone())
    {
        probe();
    }
    let attempt = Nir1LocalAttempt::capture(
        Arc::clone(state),
        caller.clone(),
        &admitted.submission,
        &admitted.scene_id,
        UnsupportedInputIntent::empty(),
        admitted.intent,
    )
    .map_err(|refusal| attempt_refusal(&refusal))?;
    #[cfg(test)]
    let attempt = with_test_hooks(attempt, hooks.as_deref());
    // The AI use policy, before the attempt exists (DR-DD1A-5).
    let purpose = send_purpose(&admitted.purpose);
    let basis = read_policy_before_attempt(&attempt, purpose)?;
    let cancel = attempt.owner().cancel_handle();
    let handle = uuid::Uuid::new_v4().simple().to_string();
    let entry = Arc::new(HandleEntry {
        handle: handle.clone(),
        caller,
        submission: admitted.submission,
        cancel,
        phase: Mutex::new(Phase::Starting),
        final_since: Mutex::new(None),
        withdrawn: AtomicBool::new(false),
        capture_settled: AtomicBool::new(false),
    });
    reservation.commit(Arc::clone(&entry));
    #[cfg(test)]
    let config = hooks
        .as_ref()
        .and_then(|hooks| hooks.transport_config)
        .unwrap_or(Nir1LocalTransportConfig::DEFAULT);
    #[cfg(not(test))]
    let config = Nir1LocalTransportConfig::DEFAULT;
    let starter_entry = Arc::clone(&entry);
    let spawned = thread::Builder::new()
        .name("nir1-local-starter".into())
        .spawn(move || run_starter(attempt, &starter_entry, purpose, basis, config));
    if spawned.is_err() {
        // The closure (and with it the attempt, which has no row yet) is
        // dropped: the owner releases its slot and permit.
        state.nir1_local_entry.remove(&handle);
        return Err(Nir1LocalRefusal::StarterUnavailable);
    }
    Ok(handle)
}

#[cfg(test)]
fn with_test_hooks(
    attempt: Nir1LocalAttempt,
    hooks: Option<&test_hooks::Nir1LocalEntryTestHooks>,
) -> Nir1LocalAttempt {
    let Some(hooks) = hooks else {
        return attempt;
    };
    if let Some(probe) = hooks.after_owner_capture.clone() {
        probe();
    }
    if let Some(setup) = hooks.owner_setup.clone() {
        setup(attempt.owner().hooks().test_hooks());
    }
    match hooks.attempt_probe.clone() {
        Some(probe) => attempt.with_probe(move |point| probe(point)),
        None => attempt,
    }
}

fn read_policy_before_attempt(
    attempt: &Nir1LocalAttempt,
    purpose: Nir1LocalSendPurpose,
) -> Result<Nir1LocalSendPolicyBasis, Nir1LocalRefusal> {
    let scope = attempt
        .owner()
        .policy_read_scope()
        .map_err(|refusal| owner_refusal(&refusal))?;
    match check_before_attempt(scope.workspace, scope.project_id, purpose, &scope.budget) {
        Nir1LocalSendPolicyOutcome::Allowed(basis) => Ok(basis),
        Nir1LocalSendPolicyOutcome::Refused(refusal) => Err(policy_refusal(&refusal)),
    }
}

/// The starter thread: the coordinator's run and then the transport. The
/// thread is a plain thread, so an owner dropped here records synchronously.
fn run_starter(
    attempt: Nir1LocalAttempt,
    entry: &HandleEntry,
    purpose: Nir1LocalSendPurpose,
    basis: Nir1LocalSendPolicyBasis,
    config: Nir1LocalTransportConfig,
) {
    let phase = match attempt.run_for_dispatch() {
        Ok((Nir1LocalAttemptOutcome::Start(transport), Some(target))) => {
            let mut input = Nir1LocalGenerationInput::new(
                target,
                purpose,
                basis,
                uuid::Uuid::new_v4().to_string(),
            );
            input.config = config;
            Phase::Running(start_local_generation(transport, input))
        }
        Ok((Nir1LocalAttemptOutcome::Start(transport), None)) => {
            let settlement = transport.settle_without_send();
            ended_from_settlement(&settlement, "target-unavailable")
        }
        Ok((Nir1LocalAttemptOutcome::NotStarted(settlement), _)) => {
            ended_from_settlement(&settlement, "not-started")
        }
        Ok((Nir1LocalAttemptOutcome::Abandoned { settlement, .. }, _)) => {
            ended_from_settlement(&settlement, "abandoned")
        }
        Err(refusal) => {
            let refusal = attempt_refusal(&refusal);
            Phase::Ended {
                state: if refusal == Nir1LocalRefusal::Cancelled {
                    Nir1LocalRunState::Cancelled
                } else {
                    Nir1LocalRunState::Failed
                },
                reason: refusal.code(),
            }
        }
    };
    entry.set_phase(phase);
}

fn ended_from_settlement(settlement: &Nir1Settlement, reason: &'static str) -> Phase {
    let state = match settlement {
        Nir1Settlement::ZeroSend(terminal)
            if terminal
                .observation
                .get("terminalStatus")
                .and_then(Value::as_str)
                == Some("cancelled") =>
        {
            Nir1LocalRunState::Cancelled
        }
        _ => Nir1LocalRunState::Failed,
    };
    Phase::Ended {
        state,
        reason: if state == Nir1LocalRunState::Cancelled {
            "cancelled"
        } else {
            reason
        },
    }
}

// ---------------------------------------------------------------------------
// nir1_local_generation_continue
// ---------------------------------------------------------------------------

fn state_word(state: Nir1LocalRunState) -> &'static str {
    match state {
        Nir1LocalRunState::Running => "running",
        Nir1LocalRunState::Succeeded => "succeeded",
        Nir1LocalRunState::Failed => "failed",
        Nir1LocalRunState::Cancelled => "cancelled",
    }
}

/// Is the caller still the registered caller of its pinned workspace?
fn caller_still_registered(state: &AppState, caller: &CallerIdentity) -> bool {
    let Some(workspace) = caller.workspace_id.as_deref() else {
        return false;
    };
    state
        .profile_egress
        .with_authorized_preparation(caller, workspace, || Ok(()))
        .is_ok()
}

pub(crate) fn generation_continue(
    state: &Arc<AppState>,
    caller: CallerIdentity,
    request: Nir1LocalHandleRequest,
) -> Nir1LocalContinueResponse {
    match continue_inner(state, &caller, &request.handle) {
        Ok(view) => Nir1LocalContinueResponse::Ok(view),
        Err(refusal) => Nir1LocalContinueResponse::Refused {
            reason: refusal.code(),
        },
    }
}

fn continue_inner(
    state: &Arc<AppState>,
    caller: &CallerIdentity,
    handle: &str,
) -> Result<Nir1LocalDeltaView, Nir1LocalRefusal> {
    if !gate_open(state) {
        return Err(Nir1LocalRefusal::GateClosed);
    }
    wire_id(handle)?;
    let entry = state
        .nir1_local_entry
        .entry_for(handle, caller)
        .ok_or(Nir1LocalRefusal::HandleNotFound)?;
    if !caller_still_registered(state, caller) {
        // Not a withdrawal: the owner stops, the capture is left alone.
        entry.cancel.cancel();
        state.nir1_local_entry.remove(handle);
        return Err(Nir1LocalRefusal::CallerRevoked);
    }
    let view = match &*entry.lock_phase() {
        Phase::Starting => Nir1LocalDeltaView {
            text: String::new(),
            thinking: String::new(),
            state: "starting",
            reason: None,
            drained: false,
        },
        Phase::Running(run) => {
            let delta = run.take_delta(NIR1_LOCAL_CONTINUE_MAX_BYTES);
            let drained =
                delta.state.is_final() && delta.text.is_empty() && delta.thinking.is_empty();
            Nir1LocalDeltaView {
                reason: if delta.state.is_final() {
                    run.outcome().map(|outcome| outcome.reason)
                } else {
                    None
                },
                text: delta.text,
                thinking: delta.thinking,
                state: state_word(delta.state),
                drained,
            }
        }
        Phase::Ended { state, reason } => Nir1LocalDeltaView {
            text: String::new(),
            thinking: String::new(),
            state: state_word(*state),
            reason: Some(reason),
            drained: true,
        },
    };
    if view.drained && !entry.withdrawal_pending() {
        state.nir1_local_entry.remove(handle);
    }
    Ok(view)
}

// ---------------------------------------------------------------------------
// nir1_local_generation_cancel
// ---------------------------------------------------------------------------

pub(crate) fn generation_cancel(
    state: &Arc<AppState>,
    caller: CallerIdentity,
    request: Nir1LocalHandleRequest,
) -> Nir1LocalCancelResponse {
    match cancel_inner(state, caller, &request.handle) {
        Ok(()) => Nir1LocalCancelResponse::Ok,
        Err(refusal) => Nir1LocalCancelResponse::Refused {
            reason: refusal.code(),
        },
    }
}

fn cancel_inner(
    state: &Arc<AppState>,
    caller: CallerIdentity,
    handle: &str,
) -> Result<(), Nir1LocalRefusal> {
    if !gate_open(state) {
        return Err(Nir1LocalRefusal::GateClosed);
    }
    wire_id(handle)?;
    let entry = state
        .nir1_local_entry
        .entry_for(handle, &caller)
        .ok_or(Nir1LocalRefusal::HandleNotFound)?;
    // A generation that is over cannot be cancelled; unless the user already
    // withdrew it (a retry of a cancel whose capture writer failed), the
    // capture stays as it is (DR-DD1A-9).
    if entry.is_final() && !entry.withdrawn.load(Ordering::Acquire) {
        return Ok(());
    }
    entry.withdrawn.store(true, Ordering::Release);
    // (1) The owner first: no database, so a send that has not started yet
    // never starts.
    entry.cancel.cancel();
    // (2) The current-turn capture, by the existing capture writer (the same
    // entry as `cancel_current_chat_input`, which also reaches the owner
    // through the registry). Only its terminal result is a success.
    match prepared::cancel_current_chat_input(
        Arc::clone(state),
        caller,
        CancelCurrentChatInputRequest::for_submission(&entry.submission),
    ) {
        Ok(receipt) => {
            debug_assert!(matches!(
                receipt.status(),
                "cancelled" | "not-current" | "not-found"
            ));
            entry.capture_settled.store(true, Ordering::Release);
            Ok(())
        }
        Err(_) => Err(Nir1LocalRefusal::CancelCaptureFailed),
    }
}

/// Main only (DD-1b binds it to a destroyed sender or a closed window): stop
/// every generation the sender started. Not a withdrawal: the owner's
/// `cancel()` only, the captures are left alone (K4/3). Returns how many
/// handles were reached.
pub(crate) fn cancel_sender(state: &AppState, sender_id: u64) -> usize {
    let reached: Vec<Arc<HandleEntry>> = {
        let mut table = state.nir1_local_entry.handles();
        let (reached, kept) = std::mem::take(&mut table.entries)
            .into_iter()
            .partition(|entry| entry.caller.sender_id == sender_id);
        table.entries = kept;
        reached
    };
    for entry in &reached {
        entry.cancel.cancel();
    }
    reached.len()
}

// ---------------------------------------------------------------------------
// The N-API wire (lib.rs calls only these). The gate is checked before any
// argument, the caller identity included, is parsed.
// ---------------------------------------------------------------------------

fn parse_wire<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, Nir1LocalRefusal> {
    serde_json::from_value(value).map_err(|_| Nir1LocalRefusal::RequestInvalid)
}

/// Main injects the caller identity; a malformed one is refused like a
/// malformed argument.
fn parse_caller(raw: &str) -> Result<CallerIdentity, Nir1LocalRefusal> {
    serde_json::from_str(raw).map_err(|_| Nir1LocalRefusal::RequestInvalid)
}

fn to_wire(response: &impl Serialize) -> String {
    serde_json::to_string(response).unwrap_or_else(|_| {
        format!(
            r#"{{"status":"refused","reason":"{}"}}"#,
            Nir1LocalRefusal::Unavailable.code()
        )
    })
}

pub(crate) fn wire_generation_start(
    state: &Arc<AppState>,
    intent: Value,
    main_verdict: Value,
    caller_identity: &str,
) -> String {
    let unavailable = |refusal: Nir1LocalRefusal| Nir1LocalStartResponse::Unavailable {
        reason: refusal.code(),
    };
    let response = if !gate_open(state) {
        unavailable(Nir1LocalRefusal::GateClosed)
    } else {
        match (
            parse_caller(caller_identity),
            parse_wire(intent),
            parse_wire(main_verdict),
        ) {
            (Ok(caller), Ok(intent), Ok(verdict)) => {
                generation_start(state, caller, intent, verdict)
            }
            _ => unavailable(Nir1LocalRefusal::RequestInvalid),
        }
    };
    to_wire(&response)
}

pub(crate) fn wire_generation_continue(
    state: &Arc<AppState>,
    request: Value,
    caller_identity: &str,
) -> String {
    let refused = |refusal: Nir1LocalRefusal| Nir1LocalContinueResponse::Refused {
        reason: refusal.code(),
    };
    let response = if !gate_open(state) {
        refused(Nir1LocalRefusal::GateClosed)
    } else {
        match (parse_caller(caller_identity), parse_wire(request)) {
            (Ok(caller), Ok(request)) => generation_continue(state, caller, request),
            _ => refused(Nir1LocalRefusal::RequestInvalid),
        }
    };
    to_wire(&response)
}

pub(crate) fn wire_generation_cancel(
    state: &Arc<AppState>,
    request: Value,
    caller_identity: &str,
) -> String {
    let refused = |refusal: Nir1LocalRefusal| Nir1LocalCancelResponse::Refused {
        reason: refusal.code(),
    };
    let response = if !gate_open(state) {
        refused(Nir1LocalRefusal::GateClosed)
    } else {
        match (parse_caller(caller_identity), parse_wire(request)) {
            (Ok(caller), Ok(request)) => generation_cancel(state, caller, request),
            _ => refused(Nir1LocalRefusal::RequestInvalid),
        }
    };
    to_wire(&response)
}

pub(crate) fn wire_conversation_create(
    state: &Arc<AppState>,
    request: Value,
    caller_identity: &str,
) -> String {
    let refused = |refusal: Nir1LocalRefusal| Nir1LocalCreateResponse::Refused {
        reason: refusal.code(),
    };
    let response = if !gate_open(state) {
        refused(Nir1LocalRefusal::GateClosed)
    } else {
        match (parse_caller(caller_identity), parse_wire(request)) {
            (Ok(caller), Ok(request)) => conversation_create(state, caller, request),
            _ => refused(Nir1LocalRefusal::RequestInvalid),
        }
    };
    to_wire(&response)
}

pub(crate) fn wire_conversation_list(state: &Arc<AppState>, caller_identity: &str) -> String {
    let response = if !gate_open(state) {
        Nir1LocalListResponse::Refused {
            reason: Nir1LocalRefusal::GateClosed.code(),
        }
    } else {
        match parse_caller(caller_identity) {
            Ok(caller) => conversation_list(state, caller),
            Err(refusal) => Nir1LocalListResponse::Refused {
                reason: refusal.code(),
            },
        }
    };
    to_wire(&response)
}

pub(crate) fn wire_conversation_read(
    state: &Arc<AppState>,
    request: Value,
    caller_identity: &str,
) -> String {
    let refused = |refusal: Nir1LocalRefusal| Nir1LocalReadResponse::Refused {
        reason: refusal.code(),
    };
    let response = if !gate_open(state) {
        refused(Nir1LocalRefusal::GateClosed)
    } else {
        match (parse_caller(caller_identity), parse_wire(request)) {
            (Ok(caller), Ok(request)) => conversation_read(state, caller, request),
            _ => refused(Nir1LocalRefusal::RequestInvalid),
        }
    };
    to_wire(&response)
}

// ---------------------------------------------------------------------------
// The conversations.
// ---------------------------------------------------------------------------

fn local_provider() -> Option<String> {
    match serde_json::to_value(AiProvider::OpenaiCompatible) {
        Ok(Value::String(provider)) => Some(provider),
        _ => None,
    }
}

pub(crate) fn conversation_create(
    state: &Arc<AppState>,
    caller: CallerIdentity,
    request: Nir1LocalConversationCreateRequest,
) -> Nir1LocalCreateResponse {
    let result = (|| {
        if !gate_open(state) {
            return Err(Nir1LocalRefusal::GateClosed);
        }
        wire_id(&request.scene_id)?;
        let (workspace, _binding) = prepared::ready_workspace_for_caller(state, &caller)
            .map_err(|error| workspace_refusal(&error))?;
        conversations::create_local_conversation_bounded(
            &workspace,
            &request.purpose.generation(),
            &request.scene_id,
            prepared::participant_sql_budget(),
        )
        .map_err(|error| {
            if format!("{error:#}").contains("NIR1_LOCAL_CONVERSATION_SCENE_REQUIRED") {
                Nir1LocalRefusal::SceneMismatch
            } else {
                Nir1LocalRefusal::Unavailable
            }
        })
    })();
    match result {
        Ok(entry) => Nir1LocalCreateResponse::Created(entry.into()),
        Err(refusal) => Nir1LocalCreateResponse::Refused {
            reason: refusal.code(),
        },
    }
}

pub(crate) fn conversation_list(
    state: &Arc<AppState>,
    caller: CallerIdentity,
) -> Nir1LocalListResponse {
    let result = (|| {
        if !gate_open(state) {
            return Err(Nir1LocalRefusal::GateClosed);
        }
        let (workspace, _binding) = prepared::ready_workspace_for_caller(state, &caller)
            .map_err(|error| workspace_refusal(&error))?;
        conversations::list_local_conversations_bounded(
            &workspace,
            prepared::participant_sql_budget(),
        )
        .map_err(|_| Nir1LocalRefusal::Unavailable)
    })();
    match result {
        Ok((entries, truncated)) => Nir1LocalListResponse::Ok {
            conversations: entries.into_iter().map(Into::into).collect(),
            truncated,
        },
        Err(refusal) => Nir1LocalListResponse::Refused {
            reason: refusal.code(),
        },
    }
}

pub(crate) fn conversation_read(
    state: &Arc<AppState>,
    caller: CallerIdentity,
    request: Nir1LocalConversationReadRequest,
) -> Nir1LocalReadResponse {
    let result = (|| {
        if !gate_open(state) {
            return Err(Nir1LocalRefusal::GateClosed);
        }
        wire_id(&request.conversation_id)?;
        let limit = usize::try_from(request.limit).map_err(|_| Nir1LocalRefusal::RequestInvalid)?;
        if limit == 0 || limit > NIR1_LOCAL_CONVERSATION_PAGE_ROWS {
            return Err(Nir1LocalRefusal::RequestInvalid);
        }
        let offset =
            usize::try_from(request.offset).map_err(|_| Nir1LocalRefusal::RequestInvalid)?;
        let provider = local_provider().ok_or(Nir1LocalRefusal::Unavailable)?;
        let (workspace, _binding) = prepared::ready_workspace_for_caller(state, &caller)
            .map_err(|error| workspace_refusal(&error))?;
        conversations::read_local_conversation_bounded(
            &workspace,
            &request.conversation_id,
            &provider,
            LOCAL_CHAT_API,
            offset,
            limit,
            NIR1_LOCAL_CONVERSATION_PAGE_BYTES,
            prepared::participant_sql_budget(),
        )
        .map_err(|error| {
            if format!("{error:#}").contains("NIR1_LOCAL_CONVERSATION_ROW_LIMIT") {
                Nir1LocalRefusal::ConversationRowLimit
            } else {
                Nir1LocalRefusal::Unavailable
            }
        })
    })();
    match result {
        Ok(LocalConversationRead::NotThisRoute) => Nir1LocalReadResponse::Refused {
            reason: Nir1LocalRefusal::NotThisRoute.code(),
        },
        Ok(LocalConversationRead::Missing) => Nir1LocalReadResponse::Refused {
            reason: Nir1LocalRefusal::ConversationMissing.code(),
        },
        Ok(LocalConversationRead::Page {
            purpose,
            rows,
            total,
            truncated,
        }) => Nir1LocalReadResponse::Ok {
            purpose: purpose_word(&purpose),
            rows: rows
                .into_iter()
                .map(|row| {
                    let kind = match row.kind {
                        LocalConversationRowKind::Input => "input",
                        LocalConversationRowKind::Output => "output",
                    };
                    match row.content {
                        Ok(content) => Nir1LocalRowView {
                            message_id: row.message_id,
                            kind,
                            created_at_ms: row.created_at_ms,
                            text: Some(content.text),
                            thinking: content.thinking,
                            attempt_status: content.attempt_status,
                            unavailable: None,
                        },
                        Err(reason) => Nir1LocalRowView {
                            message_id: row.message_id,
                            kind,
                            created_at_ms: row.created_at_ms,
                            text: None,
                            thinking: None,
                            attempt_status: None,
                            unavailable: Some(reason),
                        },
                    }
                })
                .collect(),
            total,
            truncated,
        },
        Err(refusal) => Nir1LocalReadResponse::Refused {
            reason: refusal.code(),
        },
    }
}

#[cfg(test)]
#[path = "nir1_local_entry_tests.rs"]
mod tests;
