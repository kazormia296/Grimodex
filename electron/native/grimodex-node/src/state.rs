//! Backend が保持する状態 (設計書 §4.2 の AppState) とイベント sink。
//!
//! `AppState` は Tauri 側で `app.manage(...)` される `WorkspaceState` /
//! `GlobalSettingsPath` をそのまま束ねたもの。パス解決は行わない —
//! app_data_dir は Electron main (`app.getPath("userData")`) から
//! コンストラクタで明示注入される (dirs:: を napi 内で解決しない。§4.2)。

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

use grimodex_db::events::EventSink;
use grimodex_db::ime_export::ImeExportRequestGate;
use grimodex_db::narrative_extraction::{
    ForegroundSystemWorkRun, MaintenanceWorkspaceBinding, NarrativeMaintenanceCiConfig,
    RecoveryMode,
};
use grimodex_db::{GlobalSettingsPath, WorkspaceState};
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};

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
}

pub struct NarrativeMaintenanceRecoveryGate {
    state: Mutex<NarrativeMaintenanceRecoveryState>,
}

// The generation is process-local, but it must not restart at the same value
// after a fresh Backend is created.  A durable foreground marker from an old
// process therefore cannot be released merely because the workspace metadata
// (and hence authority ID) is unchanged; StartupRecovery gets the first say.
fn fresh_narrative_maintenance_generation() -> u64 {
    // UUID v4 keeps the process-local generation distinct across an actual
    // process restart too; a monotonically-reset counter would let a new
    // process accidentally match an old durable foreground marker.
    uuid::Uuid::new_v4().as_u128() as u64
}

/// One-shot native storage for the authorized product-journey configuration.
/// Main performs the launch gate, while this state validates it again and
/// rejects every second configuration attempt.
pub struct NarrativeMaintenanceCiSeamState {
    configured: AtomicBool,
    config: Mutex<Option<NarrativeMaintenanceCiConfig>>,
}

impl Default for NarrativeMaintenanceCiSeamState {
    fn default() -> Self {
        Self {
            configured: AtomicBool::new(false),
            config: Mutex::new(None),
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

    pub fn pending_for_project_and_binding(
        &self,
        project_id: &str,
        authority_id: &str,
        generation: u64,
        product_journey_barrier_id: &str,
        correlation: &str,
    ) -> Option<ForegroundSystemWorkRun> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .find(|barrier| {
                barrier.project_id == project_id
                    && barrier.marker.authority_id == authority_id
                    && barrier.marker.generation == generation
                    && barrier.marker.product_journey_barrier_id == product_journey_barrier_id
                    && barrier.marker.correlation == correlation
            })
            .cloned()
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
                workspace_generation: fresh_narrative_maintenance_generation(),
                authority_id: None,
                recovered_work_keys: HashSet::new(),
            }),
        }
    }
}

impl NarrativeMaintenanceRecoveryGate {
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
                state.workspace_generation = state.workspace_generation.wrapping_add(1);
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
        state.workspace_generation = state.workspace_generation.wrapping_add(1);
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
    /// Gate 2 cross-encoder cache shared by diagnostic shadow and opt-in apply.
    /// The outer mutex is both the non-queuing native concurrency=1 guard and
    /// Session::run's mutable owner. Callers must use `try_lock` and return the
    /// stable `RERANKER_BUSY` marker instead of waiting behind an inference.
    pub semantic_reranker: Mutex<grimodex_semantic::reranker::RerankerRuntime>,
    /// Workspace-generation-scoped startup-recovery gate for the main-only
    /// narrative maintenance cycle.
    pub narrative_maintenance_recovery_gate: NarrativeMaintenanceRecoveryGate,
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
            chat_streams: StreamAbortRegistry::new(),
            inline_ai_streams: StreamAbortRegistry::new(),
            post_effect_abort: grimodex_post_effect::PostEffectAbortRegistry::new(),
            license: Arc::new(grimodex_license::LicenseRuntime::new(
                dir.join("license.json"),
            )),
            semantic,
            semantic_reranker: Mutex::new(grimodex_semantic::reranker::RerankerRuntime::new(
                reranker_resource_root,
            )),
            narrative_maintenance_recovery_gate: NarrativeMaintenanceRecoveryGate::default(),
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
                .pending_for_project_and_binding(
                    "project-1",
                    "authority:workspace-1",
                    1,
                    "barrier-1",
                    "correlation-1",
                )
                .expect("pending exact barrier"),
            barrier
        );
        state.clear_if_run("unrelated-run");
        assert!(state
            .pending_for_project_and_binding(
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
            .pending_for_project_and_binding(
                "project-1",
                "authority:workspace-1",
                1,
                "barrier-1",
                "correlation-1",
            )
            .is_some());
        state.clear_if_run("run-2");
        assert!(state
            .pending_for_project_and_binding(
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
    fn maintenance_generation_is_safe_and_rolls_over_without_zero() {
        const MAX_SAFE_GENERATION: u64 = (1u64 << 53) - 1;
        let gate = NarrativeMaintenanceRecoveryGate::default();
        let generation = gate.current_generation();
        assert!(generation > 0);
        assert!(generation <= MAX_SAFE_GENERATION);
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
            }),
        };
        let first_rollover = near_max.mark_workspace_swapped();
        assert!(first_rollover > 0 && first_rollover <= MAX_SAFE_GENERATION);
        let second_rollover = near_max.mark_workspace_swapped();
        assert!(second_rollover > 0 && second_rollover <= MAX_SAFE_GENERATION);
        assert!(near_max.current_generation() <= MAX_SAFE_GENERATION);

        let at_max = NarrativeMaintenanceRecoveryGate {
            state: Mutex::new(NarrativeMaintenanceRecoveryState {
                workspace_generation: MAX_SAFE_GENERATION,
                authority_id: None,
                recovered_work_keys: HashSet::new(),
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
