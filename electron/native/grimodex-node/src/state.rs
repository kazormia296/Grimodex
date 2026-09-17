//! Backend が保持する状態 (設計書 §4.2 の AppState) とイベント sink。
//!
//! `AppState` は Tauri 側で `app.manage(...)` される `WorkspaceState` /
//! `GlobalSettingsPath` をそのまま束ねたもの。パス解決は行わない —
//! app_data_dir は Electron main (`app.getPath("userData")`) から
//! コンストラクタで明示注入される (dirs:: を napi 内で解決しない。§4.2)。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;

use grimodex_db::events::EventSink;
use grimodex_db::ime_export::ImeExportRequestGate;
use grimodex_db::narrative_extraction::{
    ForegroundSystemWorkRun, MaintenanceWorkspaceBinding, NarrativeMaintenanceCiConfig,
    NarrativeMaintenanceCiFault, RecoveryMode, NARRATIVE_MAINTENANCE_MAX_SAFE_GENERATION,
};
use grimodex_db::{GlobalSettingsPath, WorkspaceState};
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};

use crate::profile_egress::ProfileEgressState;

/// main 側 `backend.onEvent((channel, payload) => …)` へ流す TSFn。
/// `ErrorStrategy::Fatal` = JS コールバックは (channel, payload) の 2 引数を
/// 直接受ける (CalleeHandled の (err, …) 形は使わない)。payload は JSON 文字列。
pub type EventTsfn = ThreadsafeFunction<(String, String), ErrorStrategy::Fatal>;

/// TSFn 登録前に emit されたイベントのバッファ上限。Phase 2 で登録前に積まれる
/// のは `backend:ready` 1 件だが、Phase 3 の 19 チャネル配線に備えて余裕を持つ。
/// あふれた分は黙って捨てる (emit はベストエフォート契約 — events::EventSink)。
const MAX_PENDING_EVENTS: usize = 256;

enum SinkState {
    /// `onEvent` 登録前。emit をバッファし、登録時に順序どおり flush する
    /// (`backend:ready` は `Backend::new` 時に emit されるため必須。§7.1)。
    Pending(Vec<(String, String)>),
    Registered(EventTsfn),
}

/// `EventSink` の napi 実装 (設計書 §7.1)。NonBlocking で JS へ流す。
/// Phase 3 で ai / post_effect の 19 チャネルはこの sink に載せ替える。
#[derive(Clone)]
pub struct EventQueue {
    inner: Arc<Mutex<SinkState>>,
}

impl EventQueue {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(SinkState::Pending(Vec::new()))),
        }
    }

    /// main 起動時に 1 回呼ばれる想定 (再登録は最後の TSFn が勝つ)。
    /// 登録前にバッファされたイベントを emit 順で flush する。
    pub fn register(&self, tsfn: EventTsfn) {
        // emit はベストエフォート契約なので、毒化ロックは中身ごと引き継ぐ
        // (イベント喪失より配信継続を優先。パニック源は spawn_blocking 側で
        // JoinError として顕在化する)。
        let mut guard = match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let prev = std::mem::replace(&mut *guard, SinkState::Registered(tsfn));
        if let (SinkState::Pending(buffered), SinkState::Registered(tsfn)) = (prev, &*guard) {
            for event in buffered {
                let _ = tsfn.call(event, ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
    }
}

impl EventSink for EventQueue {
    fn emit(&self, channel: &str, payload: serde_json::Value) {
        let event = (channel.to_string(), payload.to_string());
        let mut guard = match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        match &mut *guard {
            SinkState::Pending(buffered) => {
                if buffered.len() < MAX_PENDING_EVENTS {
                    buffered.push(event);
                }
            }
            SinkState::Registered(tsfn) => {
                // 失敗 (queue full 等) は握る — emit はベストエフォート。
                let _ = tsfn.call(event, ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
    }
}

/// grimodex-ai のストリーミング emit（`send_chat_stream` の chunk/done）を同じ
/// EventQueue（＝TSFn → main → 全窓 broadcast）へ載せる（Phase 3 バッチ3a）。
/// Tauri 側の `AppHandle::emit` と同じくベストエフォート。EventSink の実装へ委譲する。
impl grimodex_ai::emit::StreamEmitter for EventQueue {
    fn emit(&self, channel: &str, payload: serde_json::Value) {
        <Self as EventSink>::emit(self, channel, payload);
    }
}

const MAX_STREAM_ABORT_TOMBSTONES: usize = 256;

/// Recovery bookkeeping for one main-process maintenance runtime.
///
/// A workspace swap advances the generation and clears the set of recovered
/// canonical WorkKeys. Startup recovery is selected independently for each
/// identity that has not yet completed a cycle successfully; an invalid
/// request, deferred adapter, or failed cycle therefore leaves that identity
/// in StartupRecovery.
struct NarrativeMaintenanceRecoveryState {
    workspace_generation: u64,
    authority_id: Option<String>,
    recovered_work_keys: HashSet<String>,
    active_attempts: HashMap<String, MaintenanceWorkspaceBinding>,
    /// Closed while the shared workspace opener is between its final
    /// admission check and authority publication.  Attempt registration must
    /// use this same mutex so a begin cannot slip into that gap.
    maintenance_admission_closed: bool,
    #[cfg(test)]
    panic_after_admission_close: bool,
}

pub struct NarrativeMaintenanceRecoveryGate {
    state: Mutex<NarrativeMaintenanceRecoveryState>,
}

// The generation is process-local, but it must not restart at the same value
// after a fresh Backend is created.  A durable foreground marker from an old
// process therefore cannot be released merely because the workspace metadata
// (and hence authority ID) is unchanged; StartupRecovery gets the first say.
fn checked_next_narrative_maintenance_generation(current: u64) -> u64 {
    if current == 0 || current >= NARRATIVE_MAINTENANCE_MAX_SAFE_GENERATION {
        1
    } else {
        current + 1
    }
}

static NARRATIVE_MAINTENANCE_GENERATION_SEED: OnceLock<u64> = OnceLock::new();
static NARRATIVE_MAINTENANCE_GENERATION_CURSOR: AtomicU64 = AtomicU64::new(0);
static NARRATIVE_MAINTENANCE_GENERATION_USED: OnceLock<Mutex<HashSet<u64>>> = OnceLock::new();

fn process_narrative_maintenance_generation_seed() -> u64 {
    *NARRATIVE_MAINTENANCE_GENERATION_SEED.get_or_init(|| {
        let random_bits = uuid::Uuid::new_v4().as_u128();
        let masked = random_bits & u128::from(NARRATIVE_MAINTENANCE_MAX_SAFE_GENERATION);
        match u64::try_from(masked) {
            Ok(seed) if seed > 0 => seed,
            _ => 1,
        }
    })
}

fn cursor_narrative_maintenance_generation() -> u64 {
    let seed = process_narrative_maintenance_generation_seed();
    let previous = NARRATIVE_MAINTENANCE_GENERATION_CURSOR
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            Some(if current == 0 {
                seed
            } else {
                checked_next_narrative_maintenance_generation(current)
            })
        })
        .unwrap_or_default();
    if previous == 0 {
        seed
    } else {
        checked_next_narrative_maintenance_generation(previous)
    }
}

/// Allocate a generation that is safe to serialize through JavaScript's
/// Number representation. The registry closes the small race where a
/// workspace-swap rollover and a fresh Backend allocation would otherwise
/// choose the same value; it also makes every same-process allocation unique
/// until the complete 53-bit space is exhausted.
fn allocate_narrative_maintenance_generation(preferred: Option<u64>) -> u64 {
    let used = NARRATIVE_MAINTENANCE_GENERATION_USED.get_or_init(|| Mutex::new(HashSet::new()));
    let mut candidate = preferred
        .filter(|value| *value > 0 && *value <= NARRATIVE_MAINTENANCE_MAX_SAFE_GENERATION)
        .unwrap_or_else(cursor_narrative_maintenance_generation);
    loop {
        let inserted = used
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(candidate);
        if inserted {
            return candidate;
        }
        candidate = cursor_narrative_maintenance_generation();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct NarrativeMaintenanceFaultIdentity {
    pub(crate) authority_id: String,
    pub(crate) generation: u64,
    pub(crate) project_id: String,
    pub(crate) run_kind: String,
    pub(crate) semantic_epoch_id: Option<String>,
    pub(crate) work_key: String,
    pub(crate) run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct NarrativeMaintenanceFaultClaimKey {
    authority_id: String,
    generation: u64,
    project_id: String,
    run_kind: String,
    semantic_epoch_id: Option<String>,
    work_key: String,
}

#[derive(Debug, Clone)]
pub(crate) struct NarrativeMaintenanceFaultClaim {
    key: NarrativeMaintenanceFaultClaimKey,
    fault: NarrativeMaintenanceCiFault,
}

impl NarrativeMaintenanceFaultClaim {
    pub(crate) fn fault(&self) -> NarrativeMaintenanceCiFault {
        self.fault
    }
}

#[derive(Default)]
struct NarrativeMaintenanceFaultState {
    pending: HashSet<NarrativeMaintenanceFaultClaimKey>,
    consumed: HashSet<NarrativeMaintenanceFaultIdentity>,
}

/// One-shot native storage for the authorized product-journey configuration.
/// Main performs the launch gate, while this state validates it again and
/// rejects every second configuration attempt. Fault consumption is kept
/// separate from configuration so a replay, a different authority, or a
/// different workspace-generation binding cannot reuse the same injection.
pub struct NarrativeMaintenanceCiSeamState {
    configured: AtomicBool,
    config: Mutex<Option<NarrativeMaintenanceCiConfig>>,
    freshness_hold_binding: Mutex<Option<MaintenanceWorkspaceBinding>>,
    faults: Mutex<NarrativeMaintenanceFaultState>,
}

impl Default for NarrativeMaintenanceCiSeamState {
    fn default() -> Self {
        Self {
            configured: AtomicBool::new(false),
            config: Mutex::new(None),
            freshness_hold_binding: Mutex::new(None),
            faults: Mutex::new(NarrativeMaintenanceFaultState::default()),
        }
    }
}

impl NarrativeMaintenanceCiSeamState {
    pub fn configure(&self, config: NarrativeMaintenanceCiConfig) -> anyhow::Result<()> {
        config.validate()?;
        if self.configured.swap(true, Ordering::AcqRel) {
            anyhow::bail!(
                "NEX_MAINTENANCE_CI_SEAM_ALREADY_CONFIGURED: product journey seam is one-shot"
            );
        }
        let mut slot = self
            .config
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = Some(config);
        Ok(())
    }

    pub fn config(&self) -> Option<NarrativeMaintenanceCiConfig> {
        self.config
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Bind the optional Freshness hold to the first live workspace authority
    /// that consumes it. A one-shot CI seam must not silently follow a
    /// workspace handoff or generation rollover with the same project ID.
    pub(crate) fn validate_freshness_hold_binding(
        &self,
        binding: &MaintenanceWorkspaceBinding,
    ) -> anyhow::Result<()> {
        let Some(config) = self.config() else {
            return Ok(());
        };
        if config.freshness_hold_project_id.is_none() {
            return Ok(());
        }
        binding.validate()?;
        let mut bound = self
            .freshness_hold_binding
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match bound.as_ref() {
            Some(expected) if expected != binding => anyhow::bail!(
                "NEX_MAINTENANCE_CI_FRESHNESS_HOLD_BINDING_STALE: hold belongs to authority '{}' generation {}, not '{}' generation {}",
                expected.authority_id,
                expected.generation,
                binding.authority_id,
                binding.generation,
            ),
            Some(_) => Ok(()),
            None => {
                *bound = Some(binding.clone());
                Ok(())
            }
        }
    }

    /// Reserve the configured fault for one exact live authority/work
    /// identity. The Run id is deliberately attached only after the native
    /// lifecycle owner creates it; this pending reservation closes the race
    /// between two concurrent cycle calls without allowing a speculative
    /// failed call to consume the one-shot permanently.
    pub(crate) fn claim_fault_for_binding(
        &self,
        fault: NarrativeMaintenanceCiFault,
        binding: &MaintenanceWorkspaceBinding,
        project_id: &str,
        run_kind: &str,
        semantic_epoch_id: Option<&str>,
        work_key: &str,
    ) -> anyhow::Result<Option<NarrativeMaintenanceFaultClaim>> {
        binding.validate()?;
        validate_fault_identity_component(&binding.authority_id, "authorityId")?;
        validate_fault_identity_component(project_id, "projectId")?;
        validate_fault_identity_component(run_kind, "runKind")?;
        validate_fault_identity_component(work_key, "workKey")?;
        if let Some(epoch_id) = semantic_epoch_id {
            validate_fault_identity_component(epoch_id, "semanticEpochId")?;
        }
        let key = NarrativeMaintenanceFaultClaimKey {
            authority_id: binding.authority_id.clone(),
            generation: binding.generation,
            project_id: project_id.to_string(),
            run_kind: run_kind.to_string(),
            semantic_epoch_id: semantic_epoch_id.map(str::to_string),
            work_key: work_key.to_string(),
        };
        let mut faults = self
            .faults
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // The configured seam is one-shot for the whole AppState.  The
        // persisted identity still records every binding component, but a
        // workspace swap, another project, or a replay must never turn that
        // one fault into a second injection under a different key.
        if !faults.pending.is_empty() || !faults.consumed.is_empty() {
            return Ok(None);
        }
        faults.pending.insert(key.clone());
        Ok(Some(NarrativeMaintenanceFaultClaim { key, fault }))
    }

    /// Bind a reserved fault to the real Run id and the epoch selected by the
    /// lifecycle owner. A claim can be committed exactly once; a mismatched
    /// authority/generation or empty Run id fails closed.
    pub(crate) fn commit_fault_for_run(
        &self,
        claim: &NarrativeMaintenanceFaultClaim,
        run_id: &str,
        semantic_epoch_id: Option<&str>,
    ) -> anyhow::Result<()> {
        let result = (|| {
            validate_fault_identity_component(run_id, "runId")?;
            let semantic_epoch_id = semantic_epoch_id.ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_MAINTENANCE_FAULT_CLAIM_INVALID: the created Run must carry a Semantic Epoch"
                )
            })?;
            validate_fault_identity_component(semantic_epoch_id, "semanticEpochId")?;
            if let Some(expected_epoch_id) = claim.key.semantic_epoch_id.as_deref() {
                anyhow::ensure!(
                    semantic_epoch_id == expected_epoch_id,
                    "NEX_MAINTENANCE_FAULT_CLAIM_INVALID: Run Semantic Epoch does not match the claimed work identity"
                );
            }
            let mut faults = self
                .faults
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            anyhow::ensure!(
                faults.pending.remove(&claim.key),
                "NEX_MAINTENANCE_FAULT_CLAIM_INVALID: fault claim is not pending"
            );
            faults.consumed.insert(NarrativeMaintenanceFaultIdentity {
                authority_id: claim.key.authority_id.clone(),
                generation: claim.key.generation,
                project_id: claim.key.project_id.clone(),
                run_kind: claim.key.run_kind.clone(),
                semantic_epoch_id: Some(semantic_epoch_id.to_string()),
                work_key: claim.key.work_key.clone(),
                run_id: run_id.to_string(),
            });
            Ok(())
        })();
        if result.is_err() {
            // A post-claim validation/commit error must not strand the
            // process-local reservation. The durable lifecycle transaction
            // is rolled back by its caller before this cleanup is observed.
            self.release_fault_claim(claim);
        }
        result
    }

    pub(crate) fn release_fault_claim(&self, claim: &NarrativeMaintenanceFaultClaim) {
        self.faults
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pending
            .remove(&claim.key);
    }

    #[cfg(test)]
    pub(crate) fn consumed_fault_identities(&self) -> Vec<NarrativeMaintenanceFaultIdentity> {
        self.faults
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .consumed
            .iter()
            .cloned()
            .collect()
    }
}

fn validate_fault_identity_component(value: &str, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!value.is_empty(), "{name} is required");
    anyhow::ensure!(value == value.trim(), "{name} must be trimmed");
    anyhow::ensure!(!value.contains('\0'), "{name} must not contain NUL");
    Ok(())
}

/// Process-local retry handles for foreground Runs selected by the
/// product-journey barrier. The durable marker remains the source of truth;
/// these handles only avoid rediscovery after transient post-response
/// failures, including an old authority retained across a workspace swap.
pub struct NarrativeMaintenanceForegroundBarrierState {
    pending: Mutex<HashMap<String, ForegroundSystemWorkRun>>,
}

impl Default for NarrativeMaintenanceForegroundBarrierState {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }
}

impl NarrativeMaintenanceForegroundBarrierState {
    pub fn remember(&self, barrier: ForegroundSystemWorkRun) -> anyhow::Result<()> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = pending.get(&barrier.run_id) {
            anyhow::ensure!(
                existing == &barrier,
                "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_PENDING_CONFLICT: another exact foreground Run is awaiting release"
            );
            return Ok(());
        }
        pending.insert(barrier.run_id.clone(), barrier);
        Ok(())
    }

    pub fn pending_for_run_and_binding(
        &self,
        run_id: &str,
        project_id: &str,
        authority_id: &str,
        generation: u64,
        product_journey_barrier_id: &str,
        correlation: &str,
    ) -> Option<ForegroundSystemWorkRun> {
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let barrier = pending.get(run_id)?;
        (barrier.project_id == project_id
            && barrier.marker.authority_id == authority_id
            && barrier.marker.generation == generation
            && barrier.marker.product_journey_barrier_id == product_journey_barrier_id
            && barrier.marker.correlation == correlation)
            .then(|| barrier.clone())
    }

    pub fn clear_if_run(&self, run_id: &str) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.remove(run_id);
    }
}

impl Default for NarrativeMaintenanceRecoveryGate {
    fn default() -> Self {
        Self {
            state: Mutex::new(NarrativeMaintenanceRecoveryState {
                workspace_generation: allocate_narrative_maintenance_generation(None),
                authority_id: None,
                recovered_work_keys: HashSet::new(),
                active_attempts: HashMap::new(),
                maintenance_admission_closed: false,
                #[cfg(test)]
                panic_after_admission_close: false,
            }),
        }
    }
}

impl NarrativeMaintenanceRecoveryGate {
    #[cfg(test)]
    pub fn arm_panic_after_admission_close_for_test(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.panic_after_admission_close = true;
    }

    /// Test-only failpoint used through the production open/restore owners.
    /// The flag is consumed under the same mutex as admission closure so the
    /// injected panic is strictly after the close and cannot leak into a
    /// later test or workspace generation.
    #[cfg(test)]
    pub fn panic_after_admission_close_for_test(&self) {
        let should_panic = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let should_panic = state.panic_after_admission_close;
            state.panic_after_admission_close = false;
            should_panic
        };
        if should_panic {
            panic!("injected post-admission-close workspace swap panic");
        }
    }

    /// Register a process-local attempt before it can touch the pinned
    /// authority. Workspace open/restore checks this same gate immediately
    /// before swapping authorities.
    pub fn register_attempt(
        &self,
        attempt_id: &str,
        binding: &MaintenanceWorkspaceBinding,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(!attempt_id.trim().is_empty(), "attemptId is required");
        binding.validate()?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        anyhow::ensure!(
            !state.maintenance_admission_closed,
            "NEX_MAINTENANCE_ADMISSION_CLOSED: workspace swap is closing maintenance admission"
        );
        anyhow::ensure!(
            state.authority_id.as_deref() == Some(binding.authority_id.as_str())
                && state.workspace_generation == binding.generation,
            "NEX_MAINTENANCE_ATTEMPT_BINDING_MISMATCH: attempt is bound to an old workspace generation"
        );
        if let Some(existing) = state.active_attempts.get(attempt_id) {
            anyhow::ensure!(
                existing == binding,
                "NEX_MAINTENANCE_ATTEMPT_BINDING_CONFLICT: attemptId is already bound to another workspace"
            );
            return Ok(());
        }
        state
            .active_attempts
            .insert(attempt_id.to_string(), binding.clone());
        Ok(())
    }

    pub fn release_attempt(&self, attempt_id: &str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active_attempts.remove(attempt_id);
    }

    /// Fail closed before shared workspace open/restore is allowed to swap
    /// its authority. Main quiescence is the normal owner; this native check
    /// closes the final direct-native old-generation race.
    pub fn assert_no_active_attempts(&self) -> anyhow::Result<()> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        anyhow::ensure!(
            state.active_attempts.is_empty(),
            "NEX_MAINTENANCE_ATTEMPT_ACTIVE: workspace swap requires a terminal maintenance receipt"
        );
        Ok(())
    }

    /// Atomically close maintenance admission and require that no attempt is
    /// active.  The workspace opener calls this while holding its open lock,
    /// immediately before publishing a replacement authority.
    pub fn close_for_workspace_swap(&self) -> anyhow::Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        anyhow::ensure!(
            state.active_attempts.is_empty(),
            "NEX_MAINTENANCE_ATTEMPT_ACTIVE: workspace swap requires a terminal maintenance receipt"
        );
        anyhow::ensure!(
            !state.maintenance_admission_closed,
            "NEX_MAINTENANCE_ADMISSION_CLOSED: workspace swap admission is already closed"
        );
        state.maintenance_admission_closed = true;
        Ok(())
    }

    /// Reopen maintenance admission after the opener has either published a
    /// replacement binding or returned before publication.  The expected
    /// binding is checked under the same mutex so an old-generation caller
    /// cannot reopen a new workspace's admission.
    pub fn reopen_admission(
        &self,
        binding: Option<&MaintenanceWorkspaceBinding>,
    ) -> anyhow::Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        anyhow::ensure!(
            state.active_attempts.is_empty(),
            "NEX_MAINTENANCE_ATTEMPT_ACTIVE: cannot reopen admission while an attempt is active"
        );
        if let Some(binding) = binding {
            anyhow::ensure!(
                state.authority_id.as_deref() == Some(binding.authority_id.as_str())
                    && state.workspace_generation == binding.generation,
                "NEX_MAINTENANCE_ATTEMPT_BINDING_MISMATCH: admission reopen binding is stale"
            );
        }
        state.maintenance_admission_closed = false;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn maintenance_admission_is_closed(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.maintenance_admission_closed)
            .unwrap_or(true)
    }

    /// Atomically bind a live authority identity to its recovery generation.
    /// The identity is process-local and supplied by the pinned Arc in the
    /// N-API adapter; changing it clears every recovered WorkKey before the
    /// new binding is returned.
    pub fn binding_for_authority(&self, authority_id: &str) -> MaintenanceWorkspaceBinding {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.authority_id.as_deref() != Some(authority_id) {
            if state.authority_id.is_some() {
                state.workspace_generation = allocate_narrative_maintenance_generation(Some(
                    checked_next_narrative_maintenance_generation(state.workspace_generation),
                ));
            }
            state.authority_id = Some(authority_id.to_string());
            state.recovered_work_keys.clear();
        }
        MaintenanceWorkspaceBinding {
            authority_id: authority_id.to_string(),
            generation: state.workspace_generation,
        }
    }

    pub fn mode_for_binding(
        &self,
        binding: &MaintenanceWorkspaceBinding,
        work_key: &str,
    ) -> RecoveryMode {
        let recovered = self
            .state
            .lock()
            .map(|state| {
                state.authority_id.as_deref() == Some(binding.authority_id.as_str())
                    && state.workspace_generation == binding.generation
                    && state.recovered_work_keys.contains(work_key)
            })
            .unwrap_or(false);
        if recovered {
            RecoveryMode::SameProcessLive
        } else {
            RecoveryMode::StartupRecovery
        }
    }

    /// Must be called only after a cycle is fully accepted for this exact
    /// authority snapshot. A late ACK from an old authority is ignored.
    pub fn mark_recovered_for_binding(
        &self,
        binding: &MaintenanceWorkspaceBinding,
        work_key: &str,
    ) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.authority_id.as_deref() == Some(binding.authority_id.as_str())
            && state.workspace_generation == binding.generation
        {
            state.recovered_work_keys.insert(work_key.to_string());
        }
    }

    #[allow(dead_code)]
    pub fn current_generation(&self) -> u64 {
        self.state
            .lock()
            .map(|state| state.workspace_generation)
            .unwrap_or_default()
    }

    pub fn mark_workspace_swapped(&self) -> u64 {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.workspace_generation = allocate_narrative_maintenance_generation(Some(
            checked_next_narrative_maintenance_generation(state.workspace_generation),
        ));
        state.authority_id = None;
        state.recovered_work_keys.clear();
        state.workspace_generation
    }

    #[allow(dead_code)]
    pub fn mode_for(&self, generation: u64, work_key: &str) -> RecoveryMode {
        let recovered = self
            .state
            .lock()
            .map(|state| {
                state.workspace_generation == generation
                    && state.recovered_work_keys.contains(work_key)
            })
            .unwrap_or(false);
        if recovered {
            RecoveryMode::SameProcessLive
        } else {
            RecoveryMode::StartupRecovery
        }
    }

    /// Must be called only after the live cycle has validated and completed.
    #[allow(dead_code)]
    pub fn mark_recovered(&self, generation: u64, work_key: &str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.workspace_generation == generation {
            state.recovered_work_keys.insert(work_key.to_string());
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeMaintenanceCleanupOutcome {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeMaintenanceWorkTerminal {
    pub work_key: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeMaintenanceTerminalReceipt {
    pub schema_version: u8,
    pub attempt_id: String,
    /// Wire-level terminal state.  Keep this aligned with the main-process
    /// receipt parser; the internal attempt registry still uses its own enum.
    pub state: String,
    pub stop_reason: Option<String>,
    pub generation: u64,
    pub workspace_binding: MaintenanceWorkspaceBinding,
    pub published_generation: Option<u64>,
    pub works: Vec<NarrativeMaintenanceWorkTerminal>,
    pub cleanup: NarrativeMaintenanceCleanupOutcome,
    pub connection_reusable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NarrativeMaintenanceAttemptState {
    Open,
    StopRequested,
    FinalizeGranted,
    Interrupted,
    Succeeded,
}

struct NarrativeMaintenanceAttemptEntry {
    authority_id: String,
    generation: u64,
    state: NarrativeMaintenanceAttemptState,
    stop_reason: Option<String>,
    running: bool,
    /// The shared cycle owns discovery until it explicitly closes this
    /// admission.  A work can finish while discovery is still able to enqueue
    /// a repeated effective key; such a finish must not grant the attempt's
    /// final success yet.
    work_registration_open: bool,
    works: Vec<NarrativeMaintenanceWorkTerminal>,
    /// Work identities whose final durable success transaction has acquired
    /// the cancellation linearization point.  Cancellation may stop other
    /// work, but it cannot rewrite one of these identities after its owner
    /// commits.
    /// One entry is retained for every queue execution, even when multiple
    /// executions share the same canonical key.  Rediscovery can enqueue an
    /// effective key again before the cycle ends; collapsing by key would let
    /// the first success finalize the attempt while the later execution is
    /// still pending.
    finalize_grants: HashSet<usize>,
    cleanup: NarrativeMaintenanceCleanupOutcome,
    connection_reusable: bool,
    terminal: Option<NarrativeMaintenanceTerminalReceipt>,
    notify: Arc<Notify>,
}

/// Process-local owner for maintenance attempt cancellation and terminal
/// receipts. Durable Run/Task/Attempt state remains in grimodex-db; this map
/// only closes the main/native handoff race around one cycle.
pub struct NarrativeMaintenanceAttemptRegistry {
    state: Mutex<HashMap<String, NarrativeMaintenanceAttemptEntry>>,
}

impl Default for NarrativeMaintenanceAttemptRegistry {
    fn default() -> Self {
        Self {
            state: Mutex::new(HashMap::new()),
        }
    }
}

impl NarrativeMaintenanceAttemptRegistry {
    pub fn begin(
        &self,
        attempt_id: &str,
        binding: &MaintenanceWorkspaceBinding,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(!attempt_id.trim().is_empty(), "attemptId is required");
        binding.validate()?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = state.get(attempt_id) {
            anyhow::ensure!(
                existing.authority_id == binding.authority_id
                    && existing.generation == binding.generation,
                "NEX_MAINTENANCE_ATTEMPT_BINDING_CONFLICT: attemptId is already bound to another workspace"
            );
            anyhow::ensure!(
                existing.terminal.is_none(),
                "NEX_MAINTENANCE_ATTEMPT_REUSED: terminal attempt ids cannot be reused"
            );
            return Ok(());
        }
        state.insert(
            attempt_id.to_string(),
            NarrativeMaintenanceAttemptEntry {
                authority_id: binding.authority_id.clone(),
                generation: binding.generation,
                state: NarrativeMaintenanceAttemptState::Open,
                stop_reason: None,
                running: false,
                work_registration_open: false,
                works: Vec::new(),
                finalize_grants: HashSet::new(),
                cleanup: NarrativeMaintenanceCleanupOutcome {
                    status: "clean".to_string(),
                    error: None,
                },
                connection_reusable: true,
                terminal: None,
                notify: Arc::new(Notify::new()),
            },
        );
        Ok(())
    }

    pub fn start(
        &self,
        attempt_id: &str,
        work_keys: impl IntoIterator<Item = String>,
    ) -> anyhow::Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = state
            .get_mut(attempt_id)
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}"))?;
        anyhow::ensure!(
            entry.terminal.is_none(),
            "NEX_MAINTENANCE_ATTEMPT_TERMINAL: attempt already settled"
        );
        anyhow::ensure!(
            entry.state != NarrativeMaintenanceAttemptState::StopRequested,
            "NEX_MAINTENANCE_ATTEMPT_CANCELLED: attempt cancellation was accepted before work started"
        );
        entry.running = true;
        entry.work_registration_open = true;
        // A running attempt must prove cleanup before its terminal receipt is
        // reusable.  The owner upgrades this to clean only after the actual
        // Database connection has been checked at the end of the cycle.
        entry.cleanup = NarrativeMaintenanceCleanupOutcome {
            status: "failed".to_string(),
            error: Some("maintenance cleanup has not completed".to_string()),
        };
        entry.connection_reusable = false;
        entry.finalize_grants.clear();
        entry.works = work_keys
            .into_iter()
            .map(|work_key| NarrativeMaintenanceWorkTerminal {
                work_key,
                status: "not-started".to_string(),
                error: None,
            })
            .collect();
        Ok(())
    }

    pub fn mark_work_started(&self, attempt_id: &str, work_key: &str) -> anyhow::Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = state
            .get_mut(attempt_id)
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}"))?;
        anyhow::ensure!(
            entry.state != NarrativeMaintenanceAttemptState::StopRequested,
            "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation won before work start"
        );
        let work = entry
            .works
            .iter_mut()
            .find(|work| work.work_key == work_key && work.status == "not-started")
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_WORK_UNKNOWN: {work_key}"))?;
        work.status = "running".to_string();
        Ok(())
    }

    pub fn set_cleanup_outcome(
        &self,
        attempt_id: &str,
        outcome: NarrativeMaintenanceCleanupOutcome,
        connection_reusable: bool,
    ) -> anyhow::Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = state
            .get_mut(attempt_id)
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}"))?;
        anyhow::ensure!(
            entry.terminal.is_none(),
            "NEX_MAINTENANCE_ATTEMPT_TERMINAL: attempt already settled"
        );
        entry.cleanup = outcome;
        entry.connection_reusable = connection_reusable;
        Ok(())
    }

    /// Add one canonical follow-up discovered by the shared cycle.  The
    /// registration happens before the item enters the queue, so a prior
    /// work's success cannot close the attempt while this same cycle still
    /// owns another phase.
    pub fn register_work(&self, attempt_id: &str, work_key: &str) -> anyhow::Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = state
            .get_mut(attempt_id)
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}"))?;
        anyhow::ensure!(
            entry.terminal.is_none(),
            "NEX_MAINTENANCE_ATTEMPT_TERMINAL: attempt already settled"
        );
        anyhow::ensure!(
            entry.state != NarrativeMaintenanceAttemptState::StopRequested
                && entry.state != NarrativeMaintenanceAttemptState::FinalizeGranted,
            "NEX_MAINTENANCE_ATTEMPT_CANCELLED: follow-up registration is closed"
        );
        anyhow::ensure!(
            entry.work_registration_open,
            "NEX_MAINTENANCE_ATTEMPT_FINALIZE_CLOSED: work discovery is already closed"
        );
        entry.works.push(NarrativeMaintenanceWorkTerminal {
            work_key: work_key.to_string(),
            status: "not-started".to_string(),
            error: None,
        });
        Ok(())
    }

    pub fn grant_finalize(&self, attempt_id: &str) -> anyhow::Result<bool> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = state
            .get_mut(attempt_id)
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}"))?;
        if entry.terminal.is_some() {
            return Ok(false);
        }
        if entry.state == NarrativeMaintenanceAttemptState::StopRequested
            || entry.work_registration_open
        {
            return Ok(false);
        }
        entry.state = NarrativeMaintenanceAttemptState::FinalizeGranted;
        Ok(true)
    }

    /// Acquire the per-work finalization grant immediately before the owning
    /// adapter commits its terminal success transaction.  The registry mutex
    /// is the cancellation linearization point: once this returns true,
    /// request_cancel waits for the owner to mark the work terminal.
    pub fn grant_work_finalize(&self, attempt_id: &str, work_key: &str) -> anyhow::Result<bool> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = state
            .get_mut(attempt_id)
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}"))?;
        if entry.terminal.is_some()
            || entry.state == NarrativeMaintenanceAttemptState::StopRequested
        {
            return Ok(false);
        }
        let execution_index = entry
            .works
            .iter()
            .enumerate()
            .find(|(index, work)| {
                work.work_key == work_key
                    && work.status == "running"
                    && !entry.finalize_grants.contains(index)
            })
            .map(|(index, _)| index)
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_WORK_UNKNOWN: {work_key}"))?;
        entry.finalize_grants.insert(execution_index);
        Ok(true)
    }

    pub fn stop_requested(&self, attempt_id: &str) -> anyhow::Result<bool> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = state
            .get(attempt_id)
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}"))?;
        Ok(matches!(
            entry.state,
            NarrativeMaintenanceAttemptState::StopRequested
                | NarrativeMaintenanceAttemptState::Interrupted
        ))
    }

    /// Mark one exact canonical work identity after its Rust adapter and
    /// final boundary checks have completed. A concurrent stop wins the
    /// linearization, so the current item remains requeueable.
    pub fn mark_work_succeeded(&self, attempt_id: &str, work_key: &str) -> anyhow::Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = state
            .get_mut(attempt_id)
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}"))?;
        let granted_index = entry
            .finalize_grants
            .iter()
            .copied()
            .find(|index| entry.works[*index].work_key == work_key);
        let granted = granted_index.is_some();
        anyhow::ensure!(
            granted || entry.state != NarrativeMaintenanceAttemptState::StopRequested,
            "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation won at work boundary"
        );
        let execution_index = granted_index
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_WORK_UNKNOWN: {work_key}"))?;
        entry.finalize_grants.remove(&execution_index);
        let work = entry
            .works
            .get_mut(execution_index)
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_WORK_UNKNOWN: {work_key}"))?;
        work.status = "succeeded".to_string();
        if entry.finalize_grants.is_empty()
            && !entry.work_registration_open
            && entry
                .works
                .iter()
                .all(|candidate| candidate.status == "succeeded")
        {
            entry.state = NarrativeMaintenanceAttemptState::FinalizeGranted;
        }
        Ok(())
    }

    /// Close the shared cycle's discovery queue.  This is the only point at
    /// which an otherwise fully successful set of work executions may acquire
    /// the attempt-level finalization state.  Keeping registration open until
    /// the cycle returns handles Verify -> Rebuild -> Verify and epochless
    /// rediscovery that arrives after an earlier item's durable commit.
    pub fn close_work_registration(&self, attempt_id: &str) -> anyhow::Result<bool> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = state
            .get_mut(attempt_id)
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}"))?;
        anyhow::ensure!(
            entry.terminal.is_none(),
            "NEX_MAINTENANCE_ATTEMPT_TERMINAL: attempt already settled"
        );
        entry.work_registration_open = false;
        if entry.state != NarrativeMaintenanceAttemptState::StopRequested
            && entry.finalize_grants.is_empty()
            && entry
                .works
                .iter()
                .all(|candidate| candidate.status == "succeeded")
        {
            entry.state = NarrativeMaintenanceAttemptState::FinalizeGranted;
        }
        Ok(entry.state == NarrativeMaintenanceAttemptState::FinalizeGranted)
    }

    fn receipt_for(
        entry: &NarrativeMaintenanceAttemptEntry,
        status: &str,
        published_generation: Option<u64>,
    ) -> NarrativeMaintenanceTerminalReceipt {
        let mut works = entry.works.clone();
        for work in &mut works {
            if work.status == "running" {
                work.status = if status == "succeeded" {
                    "succeeded".to_string()
                } else {
                    "interrupted".to_string()
                };
            }
        }
        NarrativeMaintenanceTerminalReceipt {
            schema_version: 1,
            attempt_id: String::new(),
            state: status.to_string(),
            stop_reason: entry.stop_reason.clone(),
            generation: entry.generation,
            workspace_binding: MaintenanceWorkspaceBinding {
                authority_id: entry.authority_id.clone(),
                generation: entry.generation,
            },
            published_generation,
            works,
            cleanup: entry.cleanup.clone(),
            connection_reusable: entry.connection_reusable,
        }
    }

    pub fn settle(
        &self,
        attempt_id: &str,
        succeeded: bool,
        published_generation: Option<u64>,
    ) -> anyhow::Result<NarrativeMaintenanceTerminalReceipt> {
        let notify;
        let receipt;
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = state
                .get_mut(attempt_id)
                .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}"))?;
            if let Some(receipt) = entry.terminal.clone() {
                return Ok(receipt);
            }
            let accepted_success =
                succeeded && entry.state == NarrativeMaintenanceAttemptState::FinalizeGranted;
            // An owner that exits through panic/error without reporting its
            // granted execution must not leave the registry permanently
            // waiting.  The durable transaction did not report success, so
            // the in-flight execution is represented as interrupted below.
            entry.finalize_grants.clear();
            let status = if accepted_success {
                "succeeded"
            } else {
                "interrupted"
            };
            entry.state = if accepted_success {
                NarrativeMaintenanceAttemptState::Succeeded
            } else {
                NarrativeMaintenanceAttemptState::Interrupted
            };
            entry.running = false;
            let mut new_receipt = Self::receipt_for(entry, status, published_generation);
            new_receipt.attempt_id = attempt_id.to_string();
            entry.terminal = Some(new_receipt.clone());
            notify = Arc::clone(&entry.notify);
            receipt = new_receipt;
        }
        notify.notify_waiters();
        Ok(receipt)
    }

    /// Request cancellation. `Some` means the attempt was not running and is
    /// already terminal; `None` means the caller must await the Notify.
    pub fn request_cancel(
        &self,
        attempt_id: &str,
        reason: &str,
    ) -> anyhow::Result<Option<NarrativeMaintenanceTerminalReceipt>> {
        let notify;
        let mut immediate;
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = state
                .get_mut(attempt_id)
                .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}"))?;
            if let Some(receipt) = entry.terminal.clone() {
                return Ok(Some(receipt));
            }
            // FinalizeGranted is the commit-side linearization point. The
            // cancellation request must observe that terminal result rather
            // than manufacturing an interruption while the final transaction
            // is still being recovered.
            if entry.state == NarrativeMaintenanceAttemptState::FinalizeGranted {
                return Ok(None);
            }
            if !entry.finalize_grants.is_empty() {
                // A final transaction is already in flight. Stop later queue
                // instances, but let the granted owner mark its durable
                // success before the terminal receipt is built.
                entry.state = NarrativeMaintenanceAttemptState::StopRequested;
                entry.stop_reason = Some(reason.to_string());
                return Ok(None);
            }
            if entry.state != NarrativeMaintenanceAttemptState::FinalizeGranted {
                entry.state = NarrativeMaintenanceAttemptState::StopRequested;
                entry.stop_reason = Some(reason.to_string());
            }
            notify = Arc::clone(&entry.notify);
            immediate = if entry.running {
                None
            } else {
                Some(Self::receipt_for(entry, "interrupted", None))
            };
            if let Some(mut receipt) = immediate.clone() {
                receipt.attempt_id = attempt_id.to_string();
                entry.state = NarrativeMaintenanceAttemptState::Interrupted;
                entry.terminal = Some(receipt.clone());
                immediate = Some(receipt);
            }
        }
        if immediate.is_some() {
            notify.notify_waiters();
        }
        Ok(immediate)
    }

    pub async fn wait_for_terminal(
        &self,
        attempt_id: &str,
    ) -> anyhow::Result<NarrativeMaintenanceTerminalReceipt> {
        loop {
            // Register the notification before the second terminal check. A
            // terminal transition between the first check and registration
            // then either wakes this future or is observed by the recheck.
            let notify = {
                let state = self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let entry = state.get(attempt_id).ok_or_else(|| {
                    anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}")
                })?;
                Arc::clone(&entry.notify)
            };
            let notified = notify.notified();
            {
                let state = self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let entry = state.get(attempt_id).ok_or_else(|| {
                    anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}")
                })?;
                if let Some(receipt) = entry.terminal.clone() {
                    return Ok(receipt);
                }
            }
            notified.await;
        }
    }
}

#[derive(Debug)]
pub struct StreamCancellation {
    abort: Arc<AtomicBool>,
    quiesced: AtomicBool,
    quiesced_notify: Notify,
}

impl StreamCancellation {
    fn new(aborted: bool) -> Self {
        Self {
            abort: Arc::new(AtomicBool::new(aborted)),
            quiesced: AtomicBool::new(false),
            quiesced_notify: Notify::new(),
        }
    }

    pub fn abort_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.abort)
    }

    fn request_abort(&self) {
        self.abort.store(true, Ordering::Release);
    }

    fn mark_quiesced(&self) {
        self.quiesced.store(true, Ordering::Release);
        self.quiesced_notify.notify_waiters();
    }

    async fn wait_quiesced(&self) {
        loop {
            let notified = self.quiesced_notify.notified();
            if self.quiesced.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Debug)]
struct StreamAbortRegistryState {
    active: HashMap<String, Arc<StreamCancellation>>,
    pending: HashSet<String>,
    pending_order: VecDeque<String>,
    completed: HashSet<String>,
    completed_order: VecDeque<String>,
}

/// streamId単位のabort registry。未知IDのabortは将来到着する同一streamだけへ
/// tombstoneとして適用し、現在の別streamへは波及しない。
#[derive(Debug)]
pub struct StreamAbortRegistry {
    state: Mutex<StreamAbortRegistryState>,
}

impl StreamAbortRegistry {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(StreamAbortRegistryState {
                active: HashMap::new(),
                pending: HashSet::new(),
                pending_order: VecDeque::new(),
                completed: HashSet::new(),
                completed_order: VecDeque::new(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StreamAbortRegistryState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn register(&self, stream_id: &str) -> anyhow::Result<Arc<StreamCancellation>> {
        anyhow::ensure!(!stream_id.trim().is_empty(), "streamId is required");
        anyhow::ensure!(stream_id == stream_id.trim(), "streamId must be trimmed");
        let mut state = self.lock();
        anyhow::ensure!(
            !state.active.contains_key(stream_id) && !state.completed.contains(stream_id),
            "streamId has already been registered: {stream_id}"
        );
        let pending = state.pending.remove(stream_id);
        if pending {
            state.pending_order.retain(|id| id != stream_id);
        }
        let cancellation = Arc::new(StreamCancellation::new(pending));
        state
            .active
            .insert(stream_id.to_string(), Arc::clone(&cancellation));
        Ok(cancellation)
    }

    pub fn complete(&self, stream_id: &str, cancellation: &Arc<StreamCancellation>) {
        let mut state = self.lock();
        if state
            .active
            .get(stream_id)
            .is_some_and(|active| Arc::ptr_eq(active, cancellation))
        {
            state.active.remove(stream_id);
            state.completed.insert(stream_id.to_string());
            state.completed_order.push_back(stream_id.to_string());
            while state.completed_order.len() > MAX_STREAM_ABORT_TOMBSTONES {
                if let Some(expired) = state.completed_order.pop_front() {
                    state.completed.remove(&expired);
                }
            }
        }
        drop(state);
        cancellation.mark_quiesced();
    }

    /// trueはmatching streamがlocal quiescence済み、falseは未知IDを将来用に記録。
    pub async fn abort(&self, stream_id: &str) -> anyhow::Result<bool> {
        anyhow::ensure!(!stream_id.trim().is_empty(), "streamId is required");
        anyhow::ensure!(stream_id == stream_id.trim(), "streamId must be trimmed");
        let active = {
            let mut state = self.lock();
            if state.completed.contains(stream_id) {
                return Ok(true);
            }
            if let Some(active) = state.active.get(stream_id) {
                Some(Arc::clone(active))
            } else {
                if state.pending.insert(stream_id.to_string()) {
                    state.pending_order.push_back(stream_id.to_string());
                    while state.pending_order.len() > MAX_STREAM_ABORT_TOMBSTONES {
                        if let Some(expired) = state.pending_order.pop_front() {
                            state.pending.remove(&expired);
                        }
                    }
                }
                None
            }
        };
        let Some(active) = active else {
            return Ok(false);
        };
        active.request_abort();
        active.wait_quiesced().await;
        Ok(true)
    }

    /// Abort every currently registered stream and wait for each one to
    /// quiesce. D2a invokes this before exposing the persistent profile gate.
    pub async fn abort_all(&self) -> usize {
        let active: Vec<Arc<StreamCancellation>> = {
            let state = self.lock();
            state.active.values().cloned().collect()
        };
        for cancellation in &active {
            cancellation.request_abort();
        }
        for cancellation in &active {
            cancellation.wait_quiesced().await;
        }
        active.len()
    }
}

/// `#[napi]` class `Backend` が Arc で保持する全状態 (設計書 §4.2)。
/// Tauri の `app.manage(WorkspaceState)` / `app.manage(GlobalSettingsPath)` /
/// `app.manage(CodexMatcherState)` の napi 版。Phase 3 で abort フラグ /
/// caches を順次ここへ拡張する。
pub struct AppState {
    pub ws: WorkspaceState,
    pub gs: GlobalSettingsPath,
    /// IME 連携スナップショットの共有ルート (`<userData>/ime`)。
    /// Electron main から注入された app data 配下だけを使用する。
    pub ime_root: PathBuf,
    /// snapshot/state の tmp+rename を Electron 内で直列化する。
    pub ime_write_lock: Mutex<()>,
    /// blocking pool がIPC到着順を逆転しても古い書出しを棄却する世代管理。
    pub ime_request_gate: ImeExportRequestGate,
    pub events: EventQueue,
    /// Codex 名寄せマッチャ (Tauri の CodexMatcherState 相当 — Phase 3 バッチ1c)。
    /// rebuild 側と match 側が**同一インスタンス**を見ることが正しさの条件
    /// (別インスタンス化すると「rebuild したのに match が空」になる)。
    pub codex_matcher: Mutex<Option<grimodex_core::codex_matching::CachedMatcher>>,
    /// AI 設定ファイル `<app_data>/ai-settings.json`（Tauri の `AiSettingsPath` 相当）。
    /// キーは含まず、renderer に返して安全（keyring/safeStorage と分離）。
    pub ai_settings_path: PathBuf,
    /// Profile-wide D2a gate. This file is independent of workspace SQLite
    /// and is loaded before any renderer or workspace event is published.
    pub profile_egress: ProfileEgressState,
    pub chat_streams: StreamAbortRegistry,
    pub inline_ai_streams: StreamAbortRegistry,
    /// post-effect run_id 単位の中止レジストリ。start/multi/abort が同じ Backend
    /// インスタンス上で共有し、並走runの一方だけを中止する。
    pub post_effect_abort: grimodex_post_effect::PostEffectAbortRegistry,
    /// `<app_data>/license.json` を正本とする共有ライセンスruntime。通常の
    /// 開発/ベータbuildではfeature無効だが、IPC surfaceは常時公開する。
    pub license: Arc<grimodex_license::LicenseRuntime>,
    /// 4 semantic search cache / embedder / download registryをシェル間共有する
    /// runtime。EventQueue cloneは同じTSFn sinkを指すため、progress 2chも
    /// backend.onEvent → main → 全窓broadcastへ載る。
    pub semantic: Arc<grimodex_semantic::runtime::SemanticRuntime>,
    pub(crate) related_scenes: crate::related_scenes::RelatedScenesService,
    /// Gate 2 cross-encoder cache shared by diagnostic shadow and opt-in apply.
    /// The outer mutex is both the non-queuing native concurrency=1 guard and
    /// Session::run's mutable owner. Callers must use `try_lock` and return the
    /// stable `RERANKER_BUSY` marker instead of waiting behind an inference.
    pub semantic_reranker: Mutex<grimodex_semantic::reranker::RerankerRuntime>,
    /// Workspace-generation-scoped startup-recovery gate for the main-only
    /// narrative maintenance cycle.
    pub narrative_maintenance_recovery_gate: NarrativeMaintenanceRecoveryGate,
    /// Process-local attempt state used to linearize cancel/finalize and
    /// prevent workspace generation swaps before terminal cleanup.
    pub narrative_maintenance_attempts: NarrativeMaintenanceAttemptRegistry,
    /// One-shot, CI-only product-journey configuration. This is deliberately
    /// not part of the renderer/preload bridge or shared IPC contract.
    pub narrative_maintenance_ci_seam: NarrativeMaintenanceCiSeamState,
    /// Exact native-owned foreground Run awaiting the post-response authoring
    /// write. A failed release remains here for a later retry; a process
    /// restart can rediscover the same durable marker from SQLite.
    pub narrative_maintenance_foreground_barrier: NarrativeMaintenanceForegroundBarrierState,
    /// Serializes the two N-API mutation adapters that may rotate a
    /// Narrative Semantic Epoch. The lock covers the idempotency preflight
    /// and the shared-Rust transaction so exactly one first execution emits
    /// the observer-only main wake; replays/no-ops do not emit it.
    pub narrative_maintenance_mutation_lock: Mutex<()>,
}

impl AppState {
    #[cfg(test)]
    pub fn new(app_data_dir: &str, semantic_resource_root: &str) -> anyhow::Result<Self> {
        Self::new_with_reranker_root(app_data_dir, semantic_resource_root, None)
    }

    pub fn new_with_reranker_root(
        app_data_dir: &str,
        semantic_resource_root: &str,
        reranker_resource_root: Option<&str>,
    ) -> anyhow::Result<Self> {
        let dir = PathBuf::from(app_data_dir);
        anyhow::ensure!(
            dir.is_absolute(),
            "appDataDir must be an absolute path: {app_data_dir}"
        );
        let semantic_resource_root = PathBuf::from(semantic_resource_root);
        anyhow::ensure!(
            semantic_resource_root.is_absolute(),
            "semanticResourceRoot must be an absolute path: {}",
            semantic_resource_root.display()
        );
        let reranker_resource_root = reranker_resource_root
            .map(PathBuf::from)
            .map(|path| {
                anyhow::ensure!(
                    path.is_absolute(),
                    "rerankerResourceRoot must be an absolute path: {}",
                    path.display()
                );
                Ok(path)
            })
            .transpose()?;
        // Tauri 側 (lib.rs setup の `create_dir_all(&app_dir).ok()`) と同じ
        // best-effort。失敗しても global-settings の read は default へ
        // フォールバックし、write 時に改めてエラーになる。
        let _ = std::fs::create_dir_all(&dir);
        // resource rootは存在を要求しない。パッケージ不備/モデル未DLでもBackend全体は
        // 起動し、semantic invokeだけが明示的なmodel missing errorになる契約。
        let events = EventQueue::new();
        let semantic = Arc::new(grimodex_semantic::runtime::SemanticRuntime::new(
            grimodex_semantic::runtime::SemanticPaths {
                models_root: dir.join("models"),
                resource_semantic_root: semantic_resource_root,
            },
            Arc::new(events.clone()),
        ));
        Ok(Self {
            ws: WorkspaceState {
                inner: Mutex::new(None),
                safe_mode: grimodex_db::recovery::SafeModeState::default(),
                switching: std::sync::atomic::AtomicBool::new(false),
                open_lock: Mutex::new(()),
            },
            gs: GlobalSettingsPath {
                path: dir.join("global-settings.json"),
                write_lock: Mutex::new(()),
            },
            ime_root: dir.join("ime"),
            ime_write_lock: Mutex::new(()),
            ime_request_gate: ImeExportRequestGate::default(),
            // SemanticRuntime と renderer IPC は同じ queue を共有する。
            events,
            codex_matcher: Mutex::new(None),
            ai_settings_path: dir.join("ai-settings.json"),
            profile_egress: ProfileEgressState::new(dir.join("profile-egress.json"))?,
            chat_streams: StreamAbortRegistry::new(),
            inline_ai_streams: StreamAbortRegistry::new(),
            post_effect_abort: grimodex_post_effect::PostEffectAbortRegistry::new(),
            license: Arc::new(grimodex_license::LicenseRuntime::new(
                dir.join("license.json"),
            )),
            semantic,
            related_scenes: crate::related_scenes::RelatedScenesService::default(),
            semantic_reranker: Mutex::new(grimodex_semantic::reranker::RerankerRuntime::new(
                reranker_resource_root,
            )),
            narrative_maintenance_recovery_gate: NarrativeMaintenanceRecoveryGate::default(),
            narrative_maintenance_attempts: NarrativeMaintenanceAttemptRegistry::default(),
            narrative_maintenance_ci_seam: NarrativeMaintenanceCiSeamState::default(),
            narrative_maintenance_foreground_barrier:
                NarrativeMaintenanceForegroundBarrierState::default(),
            narrative_maintenance_mutation_lock: Mutex::new(()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scoped_stream_abort_waits_for_matching_quiescence_only() {
        let registry = Arc::new(StreamAbortRegistry::new());
        let stream_a = registry.register("stream-a").expect("register A");
        let stream_b = registry.register("stream-b").expect("register B");
        let abort_registry = Arc::clone(&registry);
        let abort =
            tokio::spawn(async move { abort_registry.abort("stream-a").await.expect("abort A") });
        tokio::task::yield_now().await;

        assert!(stream_a.abort.load(Ordering::Acquire));
        assert!(!stream_b.abort.load(Ordering::Acquire));
        assert!(
            !abort.is_finished(),
            "abort receipt must wait for quiescence"
        );

        registry.complete("stream-a", &stream_a);
        assert!(abort.await.expect("join abort"));
        assert!(!stream_b.abort.load(Ordering::Acquire));
        registry.complete("stream-b", &stream_b);
    }

    #[tokio::test]
    async fn abort_before_register_becomes_a_scoped_tombstone() {
        let registry = StreamAbortRegistry::new();
        assert!(!registry.abort("future").await.expect("queue abort"));
        let other = registry.register("other").expect("register other");
        let future = registry.register("future").expect("register future");
        assert!(!other.abort.load(Ordering::Acquire));
        assert!(future.abort.load(Ordering::Acquire));
        registry.complete("other", &other);
        registry.complete("future", &future);
    }

    #[test]
    fn app_state_rejects_relative_app_data_dir() {
        // main からの明示注入が前提 (§4.2)。相対パスは cwd 依存の迷子ディレクトリ
        // を作るので構築時に拒否する。
        let resource_root = std::env::temp_dir().join("grimodex-semantic-resources");
        let err = AppState::new("relative/app-data", &resource_root.to_string_lossy())
            .map(|_| ())
            .expect_err("相対パスは拒否");
        assert!(err.to_string().contains("absolute"));
    }

    #[test]
    fn app_state_rejects_relative_semantic_resource_root() {
        let app_data = std::env::temp_dir().join(format!("grimodex-node-state-{}", uuid_like()));
        let err = AppState::new(&app_data.to_string_lossy(), "relative/semantic-resources")
            .map(|_| ())
            .expect_err("resource rootもcwd依存を拒否");
        assert!(err.to_string().contains("semanticResourceRoot"));
    }

    #[test]
    fn app_state_builds_global_settings_path_under_app_data_dir() {
        let dir = std::env::temp_dir().join(format!("grimodex-node-state-{}", uuid_like()));
        let dir_str = dir.to_string_lossy().into_owned();
        let resource_root = dir.join("semantic-resources");
        let state = AppState::new(&dir_str, &resource_root.to_string_lossy())
            .expect("絶対パスで構築できる");
        assert_eq!(state.gs.path, dir.join("global-settings.json"));
        assert_eq!(state.semantic.paths().models_root, dir.join("models"));
        assert_eq!(state.semantic.paths().resource_semantic_root, resource_root);
        assert!(
            state.ws.inner.lock().expect("lock").is_none(),
            "初期状態では workspace 未オープン"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn event_queue_buffers_before_registration_with_cap() {
        // TSFn は Node ランタイム外で作れないため、Pending 側の挙動 (バッファ +
        // 上限で黙って捨てる) のみ Rust 単体で検証する。flush の end-to-end は
        // test/smoke.test.mjs (backend:ready 受信) が担う。
        let queue = EventQueue::new();
        for i in 0..(MAX_PENDING_EVENTS + 10) {
            queue.emit("ch", serde_json::json!({ "i": i }));
        }
        let guard = queue.inner.lock().expect("lock");
        match &*guard {
            SinkState::Pending(buffered) => {
                assert_eq!(buffered.len(), MAX_PENDING_EVENTS, "上限で打ち止め");
                assert_eq!(buffered[0].0, "ch");
                assert_eq!(buffered[0].1, r#"{"i":0}"#, "payload は JSON 文字列化");
            }
            SinkState::Registered(_) => panic!("登録前は Pending のまま"),
        }
    }

    #[test]
    fn foreground_barrier_retry_state_is_exact_run_scoped() {
        let state = NarrativeMaintenanceForegroundBarrierState::default();
        let marker = grimodex_db::narrative_extraction::NarrativeSystemWorkMarker {
            trigger: "workspace-opened".to_string(),
            canonical_work_key: "narrative-maintenance:v1/dependency-verify/project-1/dependency-verify:epoch-1/epoch/epoch-1".to_string(),
            authority_id: "authority:workspace-1".to_string(),
            generation: 1,
            product_journey_barrier_id: "barrier-1".to_string(),
            correlation: "correlation-1".to_string(),
        };
        let barrier = ForegroundSystemWorkRun {
            run_id: "run-1".to_string(),
            project_id: "project-1".to_string(),
            marker,
        };

        state
            .remember(barrier.clone())
            .expect("remember exact barrier");
        assert_eq!(
            state
                .pending_for_run_and_binding(
                    "run-1",
                    "project-1",
                    "authority:workspace-1",
                    1,
                    "barrier-1",
                    "correlation-1",
                )
                .expect("pending exact barrier"),
            barrier
        );
        assert!(state
            .pending_for_run_and_binding(
                "unrelated-run",
                "project-1",
                "authority:workspace-1",
                1,
                "barrier-1",
                "correlation-1",
            )
            .is_none());
        state.clear_if_run("unrelated-run");
        assert!(state
            .pending_for_run_and_binding(
                "run-1",
                "project-1",
                "authority:workspace-1",
                1,
                "barrier-1",
                "correlation-1",
            )
            .is_some());
        state
            .remember(barrier.clone())
            .expect("duplicate exact barrier is idempotent");
        let mut conflicting = barrier.clone();
        conflicting.run_id = "run-2".to_string();
        state
            .remember(conflicting)
            .expect("a distinct durable Run is retained independently");
        state.clear_if_run("run-1");
        assert!(state
            .pending_for_run_and_binding(
                "run-1",
                "project-1",
                "authority:workspace-1",
                1,
                "barrier-1",
                "correlation-1",
            )
            .is_none());
        assert!(state
            .pending_for_run_and_binding(
                "run-2",
                "project-1",
                "authority:workspace-1",
                1,
                "barrier-1",
                "correlation-1",
            )
            .is_some());
        state.clear_if_run("run-2");
        assert!(state
            .pending_for_run_and_binding(
                "run-2",
                "project-1",
                "authority:workspace-1",
                1,
                "barrier-1",
                "correlation-1",
            )
            .is_none());
    }

    #[test]
    fn narrative_recovery_gate_is_generation_and_work_key_scoped() {
        let gate = NarrativeMaintenanceRecoveryGate::default();
        let generation_one = gate.current_generation();
        let key_a = "narrative-maintenance:v1/backfill/project-a/key-a";
        let key_b = "narrative-maintenance:v1/backfill/project-a/key-b";

        assert_eq!(
            gate.mode_for(generation_one, key_a),
            RecoveryMode::StartupRecovery
        );
        gate.mark_recovered(generation_one, key_a);
        assert_eq!(
            gate.mode_for(generation_one, key_a),
            RecoveryMode::SameProcessLive
        );
        assert_eq!(
            gate.mode_for(generation_one, key_b),
            RecoveryMode::StartupRecovery,
            "an unscanned/deferred WorkKey must not inherit another key's ACK"
        );

        let generation_two = gate.mark_workspace_swapped();
        assert_ne!(generation_two, generation_one);
        assert_eq!(
            gate.mode_for(generation_two, key_a),
            RecoveryMode::StartupRecovery,
            "workspace handoff clears prior generation identities"
        );
        gate.mark_recovered(generation_two, key_a);
        assert_eq!(
            gate.mode_for(generation_two, key_a),
            RecoveryMode::SameProcessLive
        );
        assert_eq!(
            gate.mode_for(generation_two, key_b),
            RecoveryMode::StartupRecovery
        );
    }

    #[test]
    fn maintenance_swap_closes_begin_admission_atomically() {
        let gate = NarrativeMaintenanceRecoveryGate::default();
        let binding = gate.binding_for_authority("authority-one");
        gate.close_for_workspace_swap().expect("close admission");
        let error = gate
            .register_attempt("attempt-after-close", &binding)
            .expect_err("begin must observe the closed swap admission");
        assert!(error.to_string().contains("ADMISSION_CLOSED"));
        gate.reopen_admission(Some(&binding))
            .expect("reopen admission");
        gate.register_attempt("attempt-after-reopen", &binding)
            .expect("begin after replacement binding");
        gate.release_attempt("attempt-after-reopen");
    }

    #[test]
    fn stale_swap_reopen_keeps_admission_closed() {
        let gate = NarrativeMaintenanceRecoveryGate::default();
        let old_binding = gate.binding_for_authority("authority-old");
        gate.close_for_workspace_swap().expect("close admission");
        gate.mark_workspace_swapped();
        let error = gate
            .reopen_admission(Some(&old_binding))
            .expect_err("old binding cannot reopen a replacement workspace");
        assert!(error.to_string().contains("BINDING_MISMATCH"));
        assert!(gate.maintenance_admission_is_closed());
    }

    #[test]
    fn per_work_finalize_grant_preserves_prior_success_and_late_cancel() {
        let registry = NarrativeMaintenanceAttemptRegistry::default();
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority-one".to_string(),
            generation: 1,
        };
        registry.begin("attempt-one", &binding).expect("begin");
        registry
            .start(
                "attempt-one",
                ["work-one".to_string(), "work-two".to_string()],
            )
            .expect("start");
        registry
            .mark_work_started("attempt-one", "work-one")
            .expect("dequeue work one");
        assert!(registry
            .grant_work_finalize("attempt-one", "work-one")
            .expect("grant work one"));
        registry
            .mark_work_started("attempt-one", "work-two")
            .expect("start work two");
        assert!(registry
            .request_cancel("attempt-one", "cancelled")
            .expect("cancel request")
            .is_none());
        registry
            .mark_work_succeeded("attempt-one", "work-one")
            .expect("granted work may finish after cancel");
        let receipt = registry
            .settle("attempt-one", false, None)
            .expect("interrupt remaining work");
        assert_eq!(receipt.state, "interrupted");
        assert_eq!(receipt.works[0].status, "succeeded");
        assert_eq!(receipt.works[1].status, "interrupted");

        registry.begin("attempt-two", &binding).expect("begin two");
        registry
            .start("attempt-two", ["work-one".to_string()])
            .expect("start two");
        registry
            .mark_work_started("attempt-two", "work-one")
            .expect("dequeue work two");
        assert!(registry
            .grant_work_finalize("attempt-two", "work-one")
            .expect("grant work two"));
        registry
            .mark_work_succeeded("attempt-two", "work-one")
            .expect("complete work two");
        assert!(registry
            .close_work_registration("attempt-two")
            .expect("close work discovery"));
        assert!(registry
            .request_cancel("attempt-two", "late-cancel")
            .expect("late cancel")
            .is_none());
        let success = registry
            .settle("attempt-two", true, Some(1))
            .expect("settle successful attempt");
        assert_eq!(success.state, "succeeded");
    }

    #[test]
    fn dynamic_followup_is_registered_before_last_work_closes_attempt() {
        let registry = NarrativeMaintenanceAttemptRegistry::default();
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority-followup".to_string(),
            generation: 2,
        };
        registry.begin("attempt-followup", &binding).expect("begin");
        registry
            .start("attempt-followup", ["phase-one".to_string()])
            .expect("start");
        registry
            .register_work("attempt-followup", "phase-two")
            .expect("register followup");
        registry
            .mark_work_started("attempt-followup", "phase-one")
            .expect("dequeue phase one");
        registry
            .grant_work_finalize("attempt-followup", "phase-one")
            .expect("grant phase one");
        registry
            .mark_work_succeeded("attempt-followup", "phase-one")
            .expect("complete phase one");
        assert!(registry
            .request_cancel("attempt-followup", "cancel-before-phase-two")
            .expect("cancel followup")
            .is_none());
        let receipt = registry
            .settle("attempt-followup", false, None)
            .expect("interrupt phase two");
        assert_eq!(receipt.works[0].status, "succeeded");
        assert_eq!(receipt.works[1].status, "not-started");
    }

    #[test]
    fn dynamic_followup_cancel_while_running_preserves_prior_success() {
        let registry = NarrativeMaintenanceAttemptRegistry::default();
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority-followup-running".to_string(),
            generation: 4,
        };
        registry
            .begin("attempt-followup-running", &binding)
            .expect("begin");
        registry
            .start("attempt-followup-running", ["phase-one".to_string()])
            .expect("start initial phase");
        registry
            .register_work("attempt-followup-running", "phase-two")
            .expect("register dynamic phase");
        registry
            .mark_work_started("attempt-followup-running", "phase-two")
            .expect("start dynamic phase");
        registry
            .mark_work_started("attempt-followup-running", "phase-one")
            .expect("start initial phase");
        registry
            .grant_work_finalize("attempt-followup-running", "phase-one")
            .expect("grant initial phase");
        registry
            .mark_work_succeeded("attempt-followup-running", "phase-one")
            .expect("complete initial phase");
        assert!(registry
            .request_cancel("attempt-followup-running", "cancel-while-phase-two-running")
            .expect("cancel dynamic phase")
            .is_none());

        let receipt = registry
            .settle("attempt-followup-running", false, None)
            .expect("interrupt dynamic phase");
        assert_eq!(receipt.state, "interrupted");
        assert_eq!(receipt.works[0].status, "succeeded");
        assert_eq!(receipt.works[1].status, "interrupted");
    }

    #[test]
    fn repeated_effective_key_is_tracked_as_two_executions() {
        let registry = NarrativeMaintenanceAttemptRegistry::default();
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority-repeated-key".to_string(),
            generation: 6,
        };
        let key = "narrative-maintenance:v1/dependency-verify/project-1/work:epoch-current";
        registry
            .begin("attempt-repeated-key", &binding)
            .expect("begin");
        registry
            .start("attempt-repeated-key", std::iter::empty::<String>())
            .expect("start");
        registry
            .register_work("attempt-repeated-key", key)
            .expect("register first execution");

        registry
            .mark_work_started("attempt-repeated-key", key)
            .expect("start first execution");
        assert!(registry
            .grant_work_finalize("attempt-repeated-key", key)
            .expect("grant first execution"));
        registry
            .mark_work_succeeded("attempt-repeated-key", key)
            .expect("complete first execution");

        // The first success must not close the attempt while discovery is
        // still able to enqueue the same effective key.  Register the
        // rediscovered queue instance after the first durable commit, then
        // cancel before its final transaction obtains a grant.
        registry
            .register_work("attempt-repeated-key", key)
            .expect("register rediscovered execution");
        registry
            .mark_work_started("attempt-repeated-key", key)
            .expect("start second execution");
        assert!(registry
            .request_cancel("attempt-repeated-key", "cancel-before-second-finalize")
            .expect("cancel second execution")
            .is_none());
        assert!(!registry
            .grant_work_finalize("attempt-repeated-key", key)
            .expect("second finalization is denied"));
        let receipt = registry
            .settle("attempt-repeated-key", false, None)
            .expect("settle repeated-key interruption");
        assert_eq!(receipt.state, "interrupted");
        assert_eq!(receipt.works.len(), 2);
        assert_eq!(receipt.works[0].work_key, key);
        assert_eq!(receipt.works[0].status, "succeeded");
        assert_eq!(receipt.works[1].work_key, key);
        assert_eq!(receipt.works[1].status, "interrupted");
    }

    #[test]
    fn terminal_receipt_preserves_failed_cleanup_and_non_reusable_connection() {
        let registry = NarrativeMaintenanceAttemptRegistry::default();
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority-cleanup".to_string(),
            generation: 3,
        };
        registry.begin("attempt-cleanup", &binding).expect("begin");
        registry
            .start("attempt-cleanup", ["work".to_string()])
            .expect("start");
        registry
            .set_cleanup_outcome(
                "attempt-cleanup",
                NarrativeMaintenanceCleanupOutcome {
                    status: "failed".to_string(),
                    error: Some("hook reset failed".to_string()),
                },
                false,
            )
            .expect("record cleanup failure");
        assert!(registry
            .request_cancel("attempt-cleanup", "closed")
            .expect("request cancel")
            .is_none());
        let receipt = registry
            .settle("attempt-cleanup", false, None)
            .expect("settle");
        assert_eq!(receipt.state, "interrupted");
        assert_eq!(receipt.cleanup.status, "failed");
        assert!(!receipt.connection_reusable);
        assert_eq!(receipt.workspace_binding, binding);
    }

    #[test]
    fn empty_native_wake_can_finalize_without_fabricating_local_work() {
        let registry = NarrativeMaintenanceAttemptRegistry::default();
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority-empty-wake".to_string(),
            generation: 4,
        };
        registry
            .begin("attempt-empty-wake", &binding)
            .expect("begin");
        registry
            .start("attempt-empty-wake", std::iter::empty::<String>())
            .expect("start empty durable wake");
        assert!(registry
            .close_work_registration("attempt-empty-wake")
            .expect("close empty durable wake discovery"));
        assert!(registry
            .grant_finalize("attempt-empty-wake")
            .expect("finalize empty wake"));
        let receipt = registry
            .settle("attempt-empty-wake", true, Some(binding.generation))
            .expect("settle empty wake");
        assert_eq!(receipt.state, "succeeded");
        assert!(receipt.works.is_empty());
        assert_eq!(receipt.generation, binding.generation);
    }

    #[test]
    fn effective_epoch_identity_is_registered_before_native_start() {
        let registry = NarrativeMaintenanceAttemptRegistry::default();
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority-effective-epoch".to_string(),
            generation: 5,
        };
        registry
            .begin("attempt-effective-epoch", &binding)
            .expect("begin");
        registry
            .start("attempt-effective-epoch", std::iter::empty::<String>())
            .expect("start with wire roster deferred");
        let effective = "narrative-maintenance:v1/dependency-verify/project-1/work:epoch-current";
        registry
            .register_work("attempt-effective-epoch", effective)
            .expect("register normalized epoch identity");
        registry
            .mark_work_started("attempt-effective-epoch", effective)
            .expect("start normalized epoch identity");
        assert!(registry
            .grant_work_finalize("attempt-effective-epoch", effective)
            .expect("grant normalized epoch identity"));
        registry
            .mark_work_succeeded("attempt-effective-epoch", effective)
            .expect("complete normalized epoch identity");
        assert!(registry
            .close_work_registration("attempt-effective-epoch")
            .expect("close normalized epoch discovery"));
        let receipt = registry
            .settle("attempt-effective-epoch", true, Some(binding.generation))
            .expect("settle normalized epoch identity");
        assert_eq!(receipt.works.len(), 1);
        assert_eq!(receipt.works[0].work_key, effective);
        assert_eq!(receipt.works[0].status, "succeeded");
    }

    #[test]
    fn maintenance_generation_is_safe_and_rolls_over_without_zero() {
        const MAX_SAFE_GENERATION: u64 = (1u64 << 53) - 1;
        let gate = NarrativeMaintenanceRecoveryGate::default();
        let generation = gate.current_generation();
        assert!(generation > 0);
        assert!(generation <= MAX_SAFE_GENERATION);
        let mut allocations = HashSet::new();
        for _ in 0..8 {
            assert!(allocations.insert(allocate_narrative_maintenance_generation(None)));
        }
        assert_eq!(checked_next_narrative_maintenance_generation(0), 1);
        assert_eq!(
            checked_next_narrative_maintenance_generation(MAX_SAFE_GENERATION - 1),
            MAX_SAFE_GENERATION
        );
        assert_eq!(
            checked_next_narrative_maintenance_generation(MAX_SAFE_GENERATION),
            1
        );

        let near_max = NarrativeMaintenanceRecoveryGate {
            state: Mutex::new(NarrativeMaintenanceRecoveryState {
                workspace_generation: MAX_SAFE_GENERATION - 1,
                authority_id: None,
                recovered_work_keys: HashSet::new(),
                active_attempts: HashMap::new(),
                maintenance_admission_closed: false,
                #[cfg(test)]
                panic_after_admission_close: false,
            }),
        };
        let first_rollover = near_max.mark_workspace_swapped();
        assert!(first_rollover > 0 && first_rollover <= MAX_SAFE_GENERATION);
        let second_rollover = near_max.mark_workspace_swapped();
        assert!(second_rollover > 0 && second_rollover <= MAX_SAFE_GENERATION);
        assert_ne!(first_rollover, second_rollover);
        assert!(near_max.current_generation() <= MAX_SAFE_GENERATION);

        let at_max = NarrativeMaintenanceRecoveryGate {
            state: Mutex::new(NarrativeMaintenanceRecoveryState {
                workspace_generation: MAX_SAFE_GENERATION,
                authority_id: None,
                recovered_work_keys: HashSet::new(),
                active_attempts: HashMap::new(),
                maintenance_admission_closed: false,
                #[cfg(test)]
                panic_after_admission_close: false,
            }),
        };
        let at_max_rollover = at_max.mark_workspace_swapped();
        assert!(at_max_rollover > 0 && at_max_rollover <= MAX_SAFE_GENERATION);
    }

    #[test]
    fn fresh_recovery_gate_does_not_reuse_a_prior_process_generation() {
        let first_process = NarrativeMaintenanceRecoveryGate::default();
        let restarted_process = NarrativeMaintenanceRecoveryGate::default();
        assert_ne!(
            first_process.current_generation(),
            restarted_process.current_generation(),
            "a fresh process must enter StartupRecovery under a new binding"
        );
    }

    #[test]
    fn narrative_recovery_gate_is_authority_identity_scoped() {
        let gate = NarrativeMaintenanceRecoveryGate::default();
        let first = gate.binding_for_authority("authority-one");
        let key = "narrative-maintenance:v1/backfill/project/key";

        assert_eq!(
            gate.mode_for_binding(&first, key),
            RecoveryMode::StartupRecovery
        );
        gate.mark_recovered_for_binding(&first, key);
        assert_eq!(
            gate.mode_for_binding(&first, key),
            RecoveryMode::SameProcessLive
        );

        let second = gate.binding_for_authority("authority-two");
        assert_ne!(first, second);
        assert_eq!(
            gate.mode_for_binding(&second, key),
            RecoveryMode::StartupRecovery,
            "an old authority ACK must not recover the replacement authority"
        );
        gate.mark_recovered_for_binding(&first, key);
        assert_eq!(
            gate.mode_for_binding(&second, key),
            RecoveryMode::StartupRecovery,
            "late old-authority ACK must remain harmless"
        );
    }

    #[test]
    fn ci_fault_claim_is_one_shot_across_binding_project_and_replay() {
        let seam = NarrativeMaintenanceCiSeamState::default();
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority-one".to_string(),
            generation: 7,
        };
        let claim = seam
            .claim_fault_for_binding(
                NarrativeMaintenanceCiFault::TransientIo,
                &binding,
                "project-one",
                "backfill",
                None,
                "legacy-dependency-backfill:v2",
            )
            .expect("claim exact fault identity")
            .expect("first claim is available");
        seam.commit_fault_for_run(&claim, "run-one", Some("epoch-one"))
            .expect("bind claim to real Run and epoch");

        let consumed = seam.consumed_fault_identities();
        assert_eq!(consumed.len(), 1);
        assert_eq!(consumed[0].authority_id, "authority-one");
        assert_eq!(consumed[0].generation, 7);
        assert_eq!(consumed[0].project_id, "project-one");
        assert_eq!(consumed[0].run_id, "run-one");
        assert_eq!(consumed[0].semantic_epoch_id.as_deref(), Some("epoch-one"));

        for (other_binding, project, epoch, work_key) in [
            (
                binding.clone(),
                "project-one",
                None,
                "legacy-dependency-backfill:v2",
            ),
            (
                MaintenanceWorkspaceBinding {
                    authority_id: "authority-two".to_string(),
                    generation: 8,
                },
                "project-one",
                None,
                "legacy-dependency-backfill:v2",
            ),
            (
                binding.clone(),
                "project-two",
                None,
                "legacy-dependency-backfill:v2",
            ),
            (
                binding.clone(),
                "project-one",
                Some("epoch-two"),
                "legacy-dependency-backfill:v2",
            ),
            (binding.clone(), "project-one", None, "different-work"),
        ] {
            assert!(
                seam.claim_fault_for_binding(
                    NarrativeMaintenanceCiFault::TransientIo,
                    &other_binding,
                    project,
                    "backfill",
                    epoch,
                    work_key,
                )
                .expect("replay validation")
                .is_none(),
                "a consumed fault cannot be replayed under another identity"
            );
        }

        let pending = seam
            .claim_fault_for_binding(
                NarrativeMaintenanceCiFault::TransientIo,
                &MaintenanceWorkspaceBinding {
                    authority_id: "authority-three".to_string(),
                    generation: 9,
                },
                "project-three",
                "backfill",
                None,
                "legacy-dependency-backfill:v2",
            )
            .expect("pending claim validation");
        assert!(pending.is_none(), "consumed state remains one-shot");
    }

    #[test]
    fn ci_fault_claim_is_globally_one_shot_while_any_distinct_key_is_pending() {
        let seam = NarrativeMaintenanceCiSeamState::default();
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority-pending".to_string(),
            generation: 11,
        };
        let first = seam
            .claim_fault_for_binding(
                NarrativeMaintenanceCiFault::TransientIo,
                &binding,
                "project-one",
                "backfill",
                None,
                "legacy-dependency-backfill:v2",
            )
            .expect("first pending claim validation")
            .expect("first pending claim");
        let second = seam
            .claim_fault_for_binding(
                NarrativeMaintenanceCiFault::TransientIo,
                &binding,
                "project-two",
                "backfill",
                None,
                "legacy-dependency-backfill:v2",
            )
            .expect("distinct pending claim validation");
        assert!(
            second.is_none(),
            "a second project must not reserve a globally one-shot pending fault"
        );
        seam.release_fault_claim(&first);
    }

    #[test]
    fn ci_fault_claim_allows_only_one_pending_identity_globally() {
        let seam = Arc::new(NarrativeMaintenanceCiSeamState::default());
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let claims = std::thread::scope(|scope| {
            let first_seam = Arc::clone(&seam);
            let first_barrier = Arc::clone(&barrier);
            let first = scope.spawn(move || {
                first_barrier.wait();
                first_seam
                    .claim_fault_for_binding(
                        NarrativeMaintenanceCiFault::TransientIo,
                        &MaintenanceWorkspaceBinding {
                            authority_id: "authority-one".to_string(),
                            generation: 1,
                        },
                        "project-one",
                        "backfill",
                        None,
                        "legacy-dependency-backfill:v2",
                    )
                    .expect("first pending reservation")
                    .is_some()
            });
            let second_seam = Arc::clone(&seam);
            let second_barrier = Arc::clone(&barrier);
            let second = scope.spawn(move || {
                second_barrier.wait();
                second_seam
                    .claim_fault_for_binding(
                        NarrativeMaintenanceCiFault::TransientIo,
                        &MaintenanceWorkspaceBinding {
                            authority_id: "authority-two".to_string(),
                            generation: 2,
                        },
                        "project-two",
                        "backfill",
                        None,
                        "legacy-dependency-backfill:v2",
                    )
                    .expect("second pending reservation")
                    .is_some()
            });
            [
                first.join().expect("first reservation thread"),
                second.join().expect("second reservation thread"),
            ]
        });
        assert_eq!(claims.into_iter().filter(|claimed| *claimed).count(), 1);
    }

    #[test]
    fn failed_fault_claim_commit_releases_pending_reservation_for_retry() {
        let seam = NarrativeMaintenanceCiSeamState::default();
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority-commit-error".to_string(),
            generation: 12,
        };
        let claim = seam
            .claim_fault_for_binding(
                NarrativeMaintenanceCiFault::ContractViolation,
                &binding,
                "project-one",
                "backfill",
                Some("epoch-one"),
                "legacy-dependency-backfill:v2",
            )
            .expect("claim validation")
            .expect("pending claim");
        assert!(
            seam.commit_fault_for_run(&claim, "run-one", Some("epoch-two"))
                .is_err(),
            "a mismatched commit must fail closed"
        );
        assert!(
            seam.claim_fault_for_binding(
                NarrativeMaintenanceCiFault::ContractViolation,
                &binding,
                "project-one",
                "backfill",
                Some("epoch-one"),
                "legacy-dependency-backfill:v2",
            )
            .expect("retry claim validation")
            .is_some(),
            "a failed post-claim commit must not strand the one-shot reservation"
        );
    }

    /// テスト用の雑な一意サフィックス (uuid 依存を増やさない)。
    fn uuid_like() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        format!("{nanos}-{}", std::process::id())
    }
}
