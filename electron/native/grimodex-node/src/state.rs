//! Backend が保持する状態 (設計書 §4.2 の AppState) とイベント sink。
//!
//! `AppState` は Tauri 側で `app.manage(...)` される `WorkspaceState` /
//! `GlobalSettingsPath` をそのまま束ねたもの。パス解決は行わない —
//! app_data_dir は Electron main (`app.getPath("userData")`) から
//! コンストラクタで明示注入される (dirs:: を napi 内で解決しない。§4.2)。

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use grimodex_db::events::EventSink;
use grimodex_db::ime_export::ImeExportRequestGate;
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
    /// チャットストリームの中止フラグ (Tauri の `StreamAbortFlag` 相当 — Phase 3 バッチ3a)。
    /// send_chat_message_stream 開始側と abort_chat_stream 中止側が**同一インスタンス**を
    /// 見ることが「abort が効く」条件。単一フラグ設計（stream_id なし）は Tauri と同一。
    pub chat_abort: Arc<AtomicBool>,
    /// インライン AI ストリームの中止フラグ (Tauri の `InlineAiAbortFlag` 相当 —
    /// Phase 3 バッチ3b)。チャットとインライン AI が同時に走っても一方の中止が
    /// 他方へ波及しないよう、`chat_abort` とは別の Arc を保持する。
    pub inline_ai_abort: Arc<AtomicBool>,
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
            chat_abort: Arc::new(AtomicBool::new(false)),
            inline_ai_abort: Arc::new(AtomicBool::new(false)),
            post_effect_abort: grimodex_post_effect::PostEffectAbortRegistry::new(),
            license: Arc::new(grimodex_license::LicenseRuntime::new(
                dir.join("license.json"),
            )),
            semantic,
            semantic_reranker: Mutex::new(grimodex_semantic::reranker::RerankerRuntime::new(
                reranker_resource_root,
            )),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
