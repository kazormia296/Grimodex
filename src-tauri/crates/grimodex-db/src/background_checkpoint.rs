//! 本体の接続（`Mutex<Connection>`）から WAL の checkpoint を外す（DR-DBC-1）。
//!
//! SQLite の既定の autocheckpoint は、commit の中で、commit した接続の上で同期に走る。
//! 本体の接続はその間 Mutex を握ったままなので、前景の読み書きが待たされる
//! （IR の publish の commit の p50 1.67 s のほぼ全部、保存・設定の write の commit でも
//! p99 943 ms）。
//!
//! この module は、その checkpoint を背景の別接続へ移す。
//!
//! - 本体の接続には wal hook だけを入れる。hook は WAL の page 数が閾値
//!   （[`WAL_CHECKPOINT_PAGES`]。既定の autocheckpoint と同じ 1000 page）以上のとき
//!   背景のスレッドへ「回せ」と知らせるだけで、I/O も長い lock も行わない。
//! - 背景のスレッドは、checkpoint 専用の接続を 1 回ごとに開き、
//!   `PRAGMA wal_checkpoint(PASSIVE)` を回して閉じる。TEMP 表・ReadIdentity・stamp には
//!   関わらない（別の接続・別の TEMP・何も commit しない）。PASSIVE は書き手も読み手も
//!   待たず、WAL の先頭へ戻す（restart）のは次の書き手が行うので、本体の
//!   `data_version` ・`total_changes` ・schema_version は動かない（試験で確かめる）。
//! - 背景が使えない間（止めた後・失敗が続いた後）は、hook が既定の autocheckpoint と
//!   同じ同期の checkpoint に戻る。上限の保証は失われない。
//!
//! lifecycle：開く（`WorkspaceAuthority::new`）で始め、閉じる・workspace の切替え・
//! restore・recovery では `Database` の drop か明示の [`Database::stop_background_checkpoint`]
//! で止める。停止は、実行中の checkpoint を `sqlite3_interrupt` で中断し、上限
//! （[`STOP_WAIT`]）まで待つ。上限を過ぎたら待つのをやめ、スレッドは実行が戻った時点で
//! 接続を閉じて終わる。

use std::os::raw::{c_char, c_int, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rusqlite::{ffi, Connection, InterruptHandle, OpenFlags};

use crate::open_wal::{sqlite_wal_checkpoint, OpenWalCheckpointMode, WalCheckpointState};
use crate::Database;

/// 背景の checkpoint を起こす WAL の page 数。SQLite の既定の autocheckpoint（1000）と
/// 同じ値で、変えない（DR-DBC-1）。
pub(crate) const WAL_CHECKPOINT_PAGES: i64 = 1_000;

/// 続けて 2 回走らせる最短の間隔。読み手が WAL の先頭へ戻るのを止めている間、
/// commit のたびに知らせが来ても、checkpoint を連打しない。
const MIN_RUN_INTERVAL: Duration = Duration::from_millis(100);
/// checkpoint が最後まで終わらなかった（読み手が止めた）とき、次の commit を待たずに
/// 再試行する間隔と回数。新しい知らせが来たら回数は戻る。
const RETRY_DELAY: Duration = Duration::from_millis(500);
const MAX_RETRIES: u32 = 10;
/// checkpoint 専用の接続の open が一時的な lock に当たったときの待ち。
const CHECKPOINT_BUSY_TIMEOUT: Duration = Duration::from_millis(250);
/// 停止の待ちの上限。
pub(crate) const STOP_WAIT: Duration = Duration::from_secs(5);
/// 続けて失敗したら背景をやめ、hook を同期の checkpoint に戻す。
const MAX_CONSECUTIVE_FAILURES: u32 = 3;

const MODE_RUNNING: u8 = 0;
const MODE_STOPPED: u8 = 1;
const MODE_FAILED: u8 = 2;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Default)]
struct Control {
    /// 次の run が要る（hook が立てる）。
    pending: bool,
    running: bool,
    stop: bool,
    /// スレッドが終わった。
    exited: bool,
}

struct Shared {
    mode: AtomicU8,
    threshold: i64,
    control: Mutex<Control>,
    /// スレッドの起床・idle 待ち・終了待ちのすべてに使う（`notify_all`）。
    wake: Condvar,
    interrupt: Mutex<Option<InterruptHandle>>,
    runs: AtomicU64,
    incomplete_runs: AtomicU64,
    failures: AtomicU64,
    last_log_frames: AtomicI64,
}

impl Shared {
    fn new(threshold: i64) -> Self {
        Self {
            mode: AtomicU8::new(MODE_RUNNING),
            threshold,
            control: Mutex::new(Control::default()),
            wake: Condvar::new(),
            interrupt: Mutex::new(None),
            runs: AtomicU64::new(0),
            incomplete_runs: AtomicU64::new(0),
            failures: AtomicU64::new(0),
            last_log_frames: AtomicI64::new(-1),
        }
    }

    /// hook から。背景へ知らせられたら true。止まっている・失敗した後は false
    /// （呼び出し側が同期の checkpoint に戻る）。
    fn request(&self) -> bool {
        if self.mode.load(Ordering::SeqCst) != MODE_RUNNING {
            return false;
        }
        let mut control = lock(&self.control);
        if control.stop || control.exited {
            return false;
        }
        control.pending = true;
        drop(control);
        self.wake.notify_all();
        true
    }

    fn stop_requested(&self) -> bool {
        lock(&self.control).stop
    }
}

/// commit のたびに SQLite が呼ぶ。I/O も待ちも行わない。
unsafe extern "C" fn wal_hook(
    client_data: *mut c_void,
    db: *mut ffi::sqlite3,
    db_name: *const c_char,
    pages: c_int,
) -> c_int {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: `client_data` は `Database` が持つ `Shared` の `Arc::as_ptr`。`Database` の
        // drop が先に背景を止め、`Shared` は接続の close より後に解放される（field の順）。
        let shared = unsafe { &*client_data.cast::<Shared>() };
        if i64::from(pages) < shared.threshold {
            return;
        }
        if !shared.request() {
            // 背景が使えない。SQLite の既定の hook と同じ同期の checkpoint に戻る。
            // SAFETY: `db` と `db_name` は SQLite がこの呼び出しの間だけ有効として渡す。
            unsafe {
                ffi::sqlite3_wal_checkpoint(db, db_name);
            }
        }
    }));
    ffi::SQLITE_OK
}

struct ExitGuard(Arc<Shared>);

impl Drop for ExitGuard {
    fn drop(&mut self) {
        // 止める手順を経ずに終わったら（失敗・panic）、背景は使えない。
        let _ = self.0.mode.compare_exchange(
            MODE_RUNNING,
            MODE_FAILED,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        lock(&self.0.control).exited = true;
        self.0.wake.notify_all();
    }
}

fn run_once(shared: &Shared, db_path: &PathBuf) -> anyhow::Result<WalCheckpointState> {
    // 専用の接続。作成はしない。TEMP 表・pragma の書込み・transaction は持たない。
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(CHECKPOINT_BUSY_TIMEOUT)?;
    {
        let mut slot = lock(&shared.interrupt);
        anyhow::ensure!(!shared.stop_requested(), "BACKGROUND_CHECKPOINT_STOPPED");
        *slot = Some(conn.get_interrupt_handle());
    }
    let result = sqlite_wal_checkpoint(&conn, OpenWalCheckpointMode::Passive);
    lock(&shared.interrupt).take();
    Ok(result?)
}

/// 待つ。`pending` か `stop` で戻る。`timeout` が `Some` なら、その間に何も無くても戻る。
/// 戻り値は `stop`。
fn wait_for_work(shared: &Shared, timeout: Option<Duration>) -> bool {
    let deadline = timeout.map(|value| Instant::now() + value);
    let mut control = lock(&shared.control);
    loop {
        if control.stop {
            return true;
        }
        if control.pending {
            return false;
        }
        match deadline {
            None => {
                control = shared
                    .wake
                    .wait(control)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            Some(deadline) => {
                let now = Instant::now();
                if now >= deadline {
                    return false;
                }
                control = shared
                    .wake
                    .wait_timeout(control, deadline - now)
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
            }
        }
    }
}

/// `duration` だけ、停止の要求だけを見て待つ。停止なら true。
fn sleep_unless_stopped(shared: &Shared, duration: Duration) -> bool {
    let deadline = Instant::now() + duration;
    let mut control = lock(&shared.control);
    loop {
        if control.stop {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        control = shared
            .wake
            .wait_timeout(control, deadline - now)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0;
    }
}

fn checkpointer_main(shared: Arc<Shared>, db_path: PathBuf) {
    let _exit = ExitGuard(Arc::clone(&shared));
    let mut last_run: Option<Instant> = None;
    let mut consecutive_failures = 0_u32;
    let mut retries_left = MAX_RETRIES;
    // 直前の run が最後まで終わらなかったとき true（次の commit を待たず再試行する）。
    let mut retry = false;
    loop {
        let stopped = if retry && retries_left > 0 {
            wait_for_work(&shared, Some(RETRY_DELAY))
        } else {
            wait_for_work(&shared, None)
        };
        if stopped {
            return;
        }
        let requested = {
            let mut control = lock(&shared.control);
            let requested = control.pending;
            control.pending = false;
            requested
        };
        if requested {
            retries_left = MAX_RETRIES;
        } else {
            retries_left = retries_left.saturating_sub(1);
        }
        if let Some(previous) = last_run {
            let elapsed = previous.elapsed();
            if elapsed < MIN_RUN_INTERVAL
                && sleep_unless_stopped(&shared, MIN_RUN_INTERVAL - elapsed)
            {
                return;
            }
        }
        lock(&shared.control).running = true;
        let result = run_once(&shared, &db_path);
        lock(&shared.control).running = false;
        shared.wake.notify_all();
        last_run = Some(Instant::now());
        match result {
            Ok(state) => {
                consecutive_failures = 0;
                shared.runs.fetch_add(1, Ordering::SeqCst);
                shared
                    .last_log_frames
                    .store(state.log_frames, Ordering::SeqCst);
                retry = state.busy != 0 || state.checkpointed_frames < state.log_frames;
                if retry {
                    shared.incomplete_runs.fetch_add(1, Ordering::SeqCst);
                }
            }
            Err(error) => {
                if shared.stop_requested() {
                    return;
                }
                shared.failures.fetch_add(1, Ordering::SeqCst);
                consecutive_failures += 1;
                retry = false;
                tracing::warn!("background WAL checkpoint failed: {error}");
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    tracing::warn!(
                        "background WAL checkpoint disabled after repeated failures; \
                         falling back to synchronous checkpoints"
                    );
                    return;
                }
            }
        }
    }
}

/// 背景の checkpoint の所有者。`Database` が 1 つだけ持つ。
pub(crate) struct BackgroundCheckpointer {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StopOutcome {
    /// スレッドが終わり、join した。
    Joined,
    /// 上限までに終わらなかった。スレッドは実行が戻った時点で接続を閉じて終わる。
    TimedOut,
    /// すでに止めてあった。
    AlreadyStopped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BackgroundCheckpointStart {
    Started,
    AlreadyRunning,
    /// file の WAL 接続ではない（memory・読取専用・WAL 以外）。autocheckpoint のまま。
    NotApplicable(&'static str),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BackgroundCheckpointMode {
    Running,
    Stopped,
    Failed,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct BackgroundCheckpointStats {
    pub(crate) mode: BackgroundCheckpointMode,
    pub(crate) runs: u64,
    pub(crate) incomplete_runs: u64,
    pub(crate) failures: u64,
    pub(crate) last_log_frames: i64,
}

impl BackgroundCheckpointer {
    fn spawn(db_path: PathBuf, threshold: i64) -> anyhow::Result<Self> {
        let shared = Arc::new(Shared::new(threshold));
        let thread_shared = Arc::clone(&shared);
        let handle = std::thread::Builder::new()
            .name("grimodex-wal-checkpoint".to_string())
            .spawn(move || checkpointer_main(thread_shared, db_path))?;
        Ok(Self {
            shared,
            thread: Mutex::new(Some(handle)),
        })
    }

    fn mode(&self) -> BackgroundCheckpointMode {
        match self.shared.mode.load(Ordering::SeqCst) {
            MODE_RUNNING => BackgroundCheckpointMode::Running,
            MODE_STOPPED => BackgroundCheckpointMode::Stopped,
            _ => BackgroundCheckpointMode::Failed,
        }
    }

    #[cfg(test)]
    pub(crate) fn stats(&self) -> BackgroundCheckpointStats {
        BackgroundCheckpointStats {
            mode: self.mode(),
            runs: self.shared.runs.load(Ordering::SeqCst),
            incomplete_runs: self.shared.incomplete_runs.load(Ordering::SeqCst),
            failures: self.shared.failures.load(Ordering::SeqCst),
            last_log_frames: self.shared.last_log_frames.load(Ordering::SeqCst),
        }
    }

    #[cfg(test)]
    pub(crate) fn probe(&self) -> BackgroundCheckpointProbe {
        BackgroundCheckpointProbe {
            shared: Arc::clone(&self.shared),
        }
    }

    pub(crate) fn threshold(&self) -> i64 {
        self.shared.threshold
    }

    /// 止める。実行中の checkpoint は `sqlite3_interrupt` で中断し、`timeout` まで待つ。
    pub(crate) fn stop(&self, timeout: Duration) -> StopOutcome {
        let Some(handle) = lock(&self.thread).take() else {
            return StopOutcome::AlreadyStopped;
        };
        let shared = &self.shared;
        // 先に mode を変える。以後の hook は同期の checkpoint に戻る。
        let _ = shared.mode.compare_exchange(
            MODE_RUNNING,
            MODE_STOPPED,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        lock(&shared.control).stop = true;
        shared.wake.notify_all();
        if let Some(interrupt) = lock(&shared.interrupt).as_ref() {
            interrupt.interrupt();
        }
        let deadline = Instant::now() + timeout;
        let mut control = lock(&shared.control);
        while !control.exited {
            let now = Instant::now();
            if now >= deadline {
                drop(control);
                tracing::warn!(
                    "background WAL checkpoint did not stop within {timeout:?}; detaching it"
                );
                // handle を落とす＝detach。スレッドは `stop` を見て接続を閉じて終わる。
                drop(handle);
                return StopOutcome::TimedOut;
            }
            control = shared
                .wake
                .wait_timeout(control, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        drop(control);
        let _ = handle.join();
        StopOutcome::Joined
    }
}

#[cfg(test)]
/// 試験・診断が、`Database` を借りずに背景の状態を見る。
#[derive(Clone)]
pub(crate) struct BackgroundCheckpointProbe {
    shared: Arc<Shared>,
}

#[cfg(test)]
impl BackgroundCheckpointProbe {
    pub(crate) fn thread_exited(&self) -> bool {
        lock(&self.shared.control).exited
    }

    pub(crate) fn wait_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut control = lock(&self.shared.control);
        while control.pending || control.running {
            if control.exited {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            control = self
                .shared
                .wake
                .wait_timeout(control, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        true
    }

    pub(crate) fn wait_runs_at_least(&self, runs: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.shared.runs.load(Ordering::SeqCst) >= runs {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    pub(crate) fn request_run(&self) {
        self.shared.request();
    }

    pub(crate) fn stats_runs(&self) -> u64 {
        self.shared.runs.load(Ordering::SeqCst)
    }
}

impl Database {
    /// 本体の接続の autocheckpoint を外し、背景の checkpoint を始める。
    ///
    /// 始められないとき（memory・読取専用・WAL 以外・スレッドが作れない）は、
    /// 接続を変えずに autocheckpoint のまま返す。上限の保証は常にどちらかが持つ。
    pub(crate) fn start_background_checkpoint(&self) -> anyhow::Result<BackgroundCheckpointStart> {
        let mut slot = lock(&self.background_checkpoint);
        if let Some(existing) = slot.as_ref() {
            if existing.mode() == BackgroundCheckpointMode::Running {
                return Ok(BackgroundCheckpointStart::AlreadyRunning);
            }
        }
        let conn = self
            .conn
            .lock()
            .map_err(|error| anyhow::anyhow!("BACKGROUND_CHECKPOINT_CONNECTION_LOCKED: {error}"))?;
        let path: String = conn.query_row(
            "SELECT file FROM pragma_database_list WHERE name = 'main'",
            [],
            |row| row.get(0),
        )?;
        if path.trim().is_empty() {
            return Ok(BackgroundCheckpointStart::NotApplicable("not-file-backed"));
        }
        if conn.is_readonly("main")? {
            return Ok(BackgroundCheckpointStart::NotApplicable("read-only"));
        }
        let journal_mode: String =
            conn.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            return Ok(BackgroundCheckpointStart::NotApplicable("not-wal"));
        }
        let checkpointer =
            BackgroundCheckpointer::spawn(PathBuf::from(path), WAL_CHECKPOINT_PAGES)?;
        // SAFETY: `conn` は Mutex の guard が守る生きた接続。`Shared` は `slot` に入れる
        // `checkpointer` が持ち、`Database::drop` が背景を止めてから、接続の close より後に
        // 解放する。hook は `PRAGMA wal_autocheckpoint` に上書きされることがあるが、その場合は
        // SQLite の既定の autocheckpoint に戻るだけで、解放済みの `Shared` は触らない。
        unsafe {
            ffi::sqlite3_wal_hook(
                conn.handle(),
                Some(wal_hook),
                Arc::as_ptr(&checkpointer.shared)
                    .cast_mut()
                    .cast::<c_void>(),
            );
        }
        drop(conn);
        *slot = Some(checkpointer);
        Ok(BackgroundCheckpointStart::Started)
    }

    /// 背景の checkpoint を止める（無ければ何もしない）。以後、本体の接続の hook は
    /// 同期の checkpoint に戻る。restore・recovery の前、drop で呼ぶ。
    pub(crate) fn stop_background_checkpoint(&self) -> StopOutcome {
        let slot = lock(&self.background_checkpoint);
        match slot.as_ref() {
            Some(checkpointer) => checkpointer.stop(STOP_WAIT),
            None => StopOutcome::AlreadyStopped,
        }
    }

    /// 背景が上限を保証しているとき、その閾値（page）。open の WAL 準備が使う。
    pub(crate) fn background_checkpoint_threshold(&self) -> Option<i64> {
        let slot = lock(&self.background_checkpoint);
        slot.as_ref()
            .filter(|checkpointer| checkpointer.mode() == BackgroundCheckpointMode::Running)
            .map(BackgroundCheckpointer::threshold)
    }

    #[cfg(test)]
    pub(crate) fn background_checkpoint_stats(&self) -> Option<BackgroundCheckpointStats> {
        lock(&self.background_checkpoint)
            .as_ref()
            .map(BackgroundCheckpointer::stats)
    }

    #[cfg(test)]
    pub(crate) fn background_checkpoint_probe(&self) -> Option<BackgroundCheckpointProbe> {
        lock(&self.background_checkpoint)
            .as_ref()
            .map(BackgroundCheckpointer::probe)
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        // 本体の接続を閉じる前に背景を止める。最後の接続の close が WAL を畳めるように、
        // checkpoint 専用の接続を残さない。`Shared` は field として、この後に解放される。
        let slot = lock(&self.background_checkpoint);
        if let Some(checkpointer) = slot.as_ref() {
            checkpointer.stop(STOP_WAIT);
        }
    }
}
