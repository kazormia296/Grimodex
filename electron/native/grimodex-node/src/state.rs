//! Backend が保持する状態 (設計書 §4.2 の AppState) とイベント sink。
//!
//! `AppState` は Tauri 側で `app.manage(...)` される `WorkspaceState` /
//! `GlobalSettingsPath` をそのまま束ねたもの。パス解決は行わない —
//! app_data_dir は Electron main (`app.getPath("userData")`) から
//! コンストラクタで明示注入される (dirs:: を napi 内で解決しない。§4.2)。

use std::path::PathBuf;
use std::sync::Mutex;

use grimodex_db::events::EventSink;
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
pub struct EventQueue {
    inner: Mutex<SinkState>,
}

impl EventQueue {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SinkState::Pending(Vec::new())),
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

/// `#[napi]` class `Backend` が Arc で保持する全状態 (設計書 §4.2)。
/// Tauri の `app.manage(WorkspaceState)` / `app.manage(GlobalSettingsPath)` の
/// napi 版。Phase 3 で abort フラグ / caches / matcher をここへ拡張する。
pub struct AppState {
    pub ws: WorkspaceState,
    pub gs: GlobalSettingsPath,
    pub events: EventQueue,
}

impl AppState {
    pub fn new(app_data_dir: &str) -> anyhow::Result<Self> {
        let dir = PathBuf::from(app_data_dir);
        anyhow::ensure!(
            dir.is_absolute(),
            "appDataDir must be an absolute path: {app_data_dir}"
        );
        // Tauri 側 (lib.rs setup の `create_dir_all(&app_dir).ok()`) と同じ
        // best-effort。失敗しても global-settings の read は default へ
        // フォールバックし、write 時に改めてエラーになる。
        let _ = std::fs::create_dir_all(&dir);
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
            events: EventQueue::new(),
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
        let err = AppState::new("relative/app-data")
            .map(|_| ())
            .expect_err("相対パスは拒否");
        assert!(err.to_string().contains("absolute"));
    }

    #[test]
    fn app_state_builds_global_settings_path_under_app_data_dir() {
        let dir = std::env::temp_dir().join(format!("grimodex-node-state-{}", uuid_like()));
        let dir_str = dir.to_string_lossy().into_owned();
        let state = AppState::new(&dir_str).expect("絶対パスで構築できる");
        assert_eq!(state.gs.path, dir.join("global-settings.json"));
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
