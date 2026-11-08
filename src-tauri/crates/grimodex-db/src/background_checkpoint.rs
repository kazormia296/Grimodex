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
//! で止める。停止は、実行中の checkpoint を `sqlite3_interrupt` で中断し（待ちの間、打ち直す）、
//! 上限（[`STOP_WAIT`]）まで、スレッドの終了の証拠を待つ。
//!
//! 上限までに終了の証拠が取れない（`StopOutcome::TimedOut`）とき、restore は中止して
//! 元の authority を戻し、recovery の retire は `Err` を返す（fail-closed）。専用の接続は
//! `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE` で開くので、最後の接続として閉じても `-wal`／`-shm` を
//! 消さない。停止の要求の後は、専用の接続を新しく開かない。
//!
//! 背景が追いつかないとき（commit が続く burst）の上限は [`MAX_WAL_PAGES_BEFORE_SYNC`]：
//! それ以上では hook が同期の checkpoint に戻る。

use std::os::raw::{c_char, c_int, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rusqlite::{config::DbConfig, ffi, Connection, InterruptHandle, OpenFlags};

use crate::open_wal::{sqlite_wal_checkpoint, OpenWalCheckpointMode, WalCheckpointState};
use crate::Database;

/// 背景の checkpoint を起こす WAL の page 数。SQLite の既定の autocheckpoint（1000）と
/// 同じ値で、変えない（DR-DBC-1）。
pub(crate) const WAL_CHECKPOINT_PAGES: i64 = 1_000;

/// 背景が追いつかないとき（commit が続く burst、読み手が止めている間）の WAL の上限。
/// PASSIVE は開始時点の末尾までしか書き戻さず、WAL の先頭へ戻すのは次の書き手なので、
/// 書込みが続くと WAL は伸びる。閾値の 4 倍（4000 page。4 KiB page で約 16 MB）以上になったら、
/// hook が SQLite の既定と同じ同期の checkpoint に戻る。値は、既定の autocheckpoint の
/// 実測の最大（3622 page、約 15 MB）と同じ程度（DR-DBC-1）。
pub(crate) const MAX_WAL_PAGES_BEFORE_SYNC: i64 = 4 * WAL_CHECKPOINT_PAGES;

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
/// 停止の待ちの間、実行中の checkpoint へ interrupt を打ち直す間隔（handle の登録から
/// step の開始までの間に届いた interrupt は、step の開始で消えるため）。
const INTERRUPT_REPEAT: Duration = Duration::from_millis(50);
/// 上限を超えた hook が、背景の run の終了を待つ上限（本体の接続の busy_timeout と同じ 5 s）。
const SYNC_WAIT: Duration = Duration::from_secs(5);
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
    /// 上限を超えた hook が同期の checkpoint を行っている間。背景は新しい run を始めない。
    sync_active: bool,
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
    /// hook が同期の checkpoint に戻った回数（背景が使えない・WAL が上限を超えた）。
    sync_fallbacks: AtomicU64,
    /// 同期の checkpoint が WAL を最後まで書き戻せなかった回数（busy・読み手）。
    sync_incomplete: AtomicU64,
    last_log_frames: AtomicI64,
    stop_wait_ms: AtomicU64,
    /// 試験用の注入点：true の間、run は停止の要求を無視して専用の接続を開く前で止まる。
    #[cfg(test)]
    stall: std::sync::atomic::AtomicBool,
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
            sync_fallbacks: AtomicU64::new(0),
            sync_incomplete: AtomicU64::new(0),
            last_log_frames: AtomicI64::new(-1),
            stop_wait_ms: AtomicU64::new(u64::try_from(STOP_WAIT.as_millis()).unwrap_or(u64::MAX)),
            #[cfg(test)]
            stall: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn stop_wait(&self) -> Duration {
        Duration::from_millis(self.stop_wait_ms.load(Ordering::SeqCst))
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

    /// 上限を超えた hook から。背景の run が終わるのを（`wait` まで）待ち、同期の checkpoint の
    /// 間は背景が新しい run を始めないようにする。PASSIVE は checkpoint の lock を持つ別の
    /// 接続がいると何もせずに BUSY で戻る（背景の run が長いと、書き手が先に進んで WAL の先頭へ
    /// 戻れない）ので、同期の checkpoint は背景の run と重ならないようにする。
    /// 待ちが上限を過ぎたら false（背景が止まらない異常。同期の checkpoint は試すだけ）。
    fn enter_sync(&self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        let mut control = lock(&self.control);
        while control.running {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            control = self
                .wake
                .wait_timeout(control, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        control.sync_active = true;
        true
    }

    fn leave_sync(&self) {
        lock(&self.control).sync_active = false;
        self.wake.notify_all();
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
        // 背景が使えない：SQLite の既定の hook と同じ同期の PASSIVE checkpoint に戻る。
        // 背景が追いつかず WAL が上限を超えた：背景の run が終わるのを待ってから、同期の PASSIVE
        // checkpoint を行う（`enter_sync`）。書き手が止まらない限り、背景の 1 回の run が追いつく
        // 前に WAL が伸びる（PASSIVE は開始時点の末尾までしか書き戻さず、WAL の先頭へ戻すのは
        // 「書き手が始まる時に全部書き戻し済み」のときだけ）ので、この待ち（最大 `SYNC_WAIT`）が、
        // 前景への唯一の back-pressure になる。
        let requested = shared.request();
        let over_limit = i64::from(pages) >= MAX_WAL_PAGES_BEFORE_SYNC;
        if !requested || over_limit {
            let entered = over_limit && shared.enter_sync(SYNC_WAIT);
            // SAFETY: `db` と `db_name` は SQLite がこの呼び出しの間だけ有効として渡す。
            let rc = unsafe { ffi::sqlite3_wal_checkpoint(db, db_name) };
            if entered {
                shared.leave_sync();
            }
            shared.sync_fallbacks.fetch_add(1, Ordering::SeqCst);
            if rc != ffi::SQLITE_OK {
                shared.sync_incomplete.fetch_add(1, Ordering::SeqCst);
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

/// 専用の接続。作成はしない。TEMP 表・pragma の書込み・transaction は持たない。
fn open_checkpoint_connection(db_path: &PathBuf) -> anyhow::Result<Connection> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(CHECKPOINT_BUSY_TIMEOUT)?;
    // この接続が最後の接続として閉じても、close 時の checkpoint と `-wal`／`-shm` の削除を
    // しない（path で消すので、置き換えた後の file の WAL を消しうる）。
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)?;
    Ok(conn)
}

/// run を始める。同期の checkpoint の間は待つ。停止の要求なら false。
fn begin_run(shared: &Shared) -> bool {
    let mut control = lock(&shared.control);
    while control.sync_active && !control.stop {
        control = shared
            .wake
            .wait(control)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    if control.stop {
        return false;
    }
    control.running = true;
    true
}

fn run_once(shared: &Shared, db_path: &PathBuf) -> anyhow::Result<WalCheckpointState> {
    #[cfg(test)]
    while shared.stall.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(1));
    }
    // 停止の要求の後は、専用の接続を開かない（置換の後に新しい file を開く窓を作らない）。
    anyhow::ensure!(!shared.stop_requested(), "BACKGROUND_CHECKPOINT_STOPPED");
    let conn = open_checkpoint_connection(db_path)?;
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
        if !begin_run(&shared) {
            return;
        }
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
    pub(crate) sync_fallbacks: u64,
    pub(crate) sync_incomplete: u64,
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
            sync_fallbacks: self.shared.sync_fallbacks.load(Ordering::SeqCst),
            sync_incomplete: self.shared.sync_incomplete.load(Ordering::SeqCst),
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

    /// 止める。実行中の checkpoint は `sqlite3_interrupt` で中断し（届かないことがあるので
    /// 待ちの間に打ち直す）、`timeout` まで待つ。
    ///
    /// 終了の証拠（スレッドの `exited`）が取れたときだけ `Joined` を返す。取れなければ
    /// `TimedOut` で、JoinHandle は残す（次の `stop` が同じスレッドをもう一度待てる）。
    /// 呼び出し側は `TimedOut` のまま、live file を置き換える・接続を差し替える段へ進まない。
    pub(crate) fn stop(&self, timeout: Duration) -> StopOutcome {
        if lock(&self.thread).is_none() {
            return StopOutcome::AlreadyStopped;
        }
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
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(interrupt) = lock(&shared.interrupt).as_ref() {
                interrupt.interrupt();
            }
            let control = lock(&shared.control);
            if control.exited {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                drop(control);
                tracing::warn!(
                    "background WAL checkpoint did not stop within {timeout:?}; it is still running"
                );
                return StopOutcome::TimedOut;
            }
            let slice = (deadline - now).min(INTERRUPT_REPEAT);
            drop(
                shared
                    .wake
                    .wait_timeout(control, slice)
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
            );
        }
        match lock(&self.thread).take() {
            Some(handle) => {
                let _ = handle.join();
                StopOutcome::Joined
            }
            None => StopOutcome::AlreadyStopped,
        }
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

    pub(crate) fn set_stall(&self, stall: bool) {
        self.shared.stall.store(stall, Ordering::SeqCst);
    }

    pub(crate) fn set_stop_wait(&self, wait: Duration) {
        self.shared.stop_wait_ms.store(
            u64::try_from(wait.as_millis()).unwrap_or(u64::MAX),
            Ordering::SeqCst,
        );
    }

    pub(crate) fn is_running(&self) -> bool {
        lock(&self.shared.control).running
    }

    pub(crate) fn wait_running(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.is_running() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        false
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
        // 鍵の順は、接続の Mutex → slot（`background_checkpoint_bound` と同じ）。
        let conn = self
            .conn
            .lock()
            .map_err(|error| anyhow::anyhow!("BACKGROUND_CHECKPOINT_CONNECTION_LOCKED: {error}"))?;
        let mut slot = lock(&self.background_checkpoint);
        if let Some(existing) = slot.as_ref() {
            if existing.mode() == BackgroundCheckpointMode::Running {
                return Ok(BackgroundCheckpointStart::AlreadyRunning);
            }
        }
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
            Some(checkpointer) => checkpointer.stop(checkpointer.shared.stop_wait()),
            None => StopOutcome::AlreadyStopped,
        }
    }

    /// 背景が動いているときの閾値（page。試験用。open の WAL 準備は `background_checkpoint_bound`）。
    #[cfg(test)]
    pub(crate) fn background_checkpoint_threshold(&self) -> Option<i64> {
        let slot = lock(&self.background_checkpoint);
        slot.as_ref()
            .filter(|checkpointer| checkpointer.mode() == BackgroundCheckpointMode::Running)
            .map(BackgroundCheckpointer::threshold)
    }

    /// open の WAL 準備が単位に使う、背景が実際に守っている上限（page）。背景が動いていて、
    /// かつ `conn` の wal hook がその背景のものであると確かめられたときだけ `Some`。
    ///
    /// 確かめは `sqlite3_wal_hook` の再設定：同じ callback と引数を入れ直し、戻り値（直前の
    /// 引数）が背景の `Shared` と一致するかを見る。一致しなければ（hook が別のものに
    /// 置き換わっている）入れ直した上で `None` を返し、呼び出し側は上限なしとして拒否する。
    /// 呼び出し側は `conn` を持っている（鍵の順は接続 → slot）。
    pub(crate) fn background_checkpoint_bound(&self, conn: &Connection) -> Option<i64> {
        let slot = lock(&self.background_checkpoint);
        let checkpointer = slot
            .as_ref()
            .filter(|checkpointer| checkpointer.mode() == BackgroundCheckpointMode::Running)?;
        let ours = Arc::as_ptr(&checkpointer.shared)
            .cast_mut()
            .cast::<c_void>();
        // SAFETY: `conn` は借用中の生きた接続。同じ callback と引数を入れ直すだけで、
        // 戻り値は直前の引数のポインタ（解引用しない）。
        let previous = unsafe { ffi::sqlite3_wal_hook(conn.handle(), Some(wal_hook), ours) };
        if previous == ours {
            Some(checkpointer.threshold())
        } else {
            tracing::warn!(
                "workspace WAL hook was replaced; the background checkpoint bound is not in effect"
            );
            None
        }
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
            checkpointer.stop(checkpointer.shared.stop_wait());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (PathBuf, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("grimodex-bg-ckpt-unit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        (dir.clone(), dir.join("unit.db"))
    }

    fn wal_of(path: &std::path::Path) -> PathBuf {
        let mut name = path.as_os_str().to_owned();
        name.push("-wal");
        PathBuf::from(name)
    }

    /// 停止の要求の後は、専用の接続を開く前に終わる（開けない path でも open の失敗にならない）。
    #[test]
    fn a_stop_request_ends_the_run_before_any_connection_is_opened() {
        let shared = Shared::new(WAL_CHECKPOINT_PAGES);
        lock(&shared.control).stop = true;
        let missing =
            std::env::temp_dir().join(format!("grimodex-missing-{}.db", uuid::Uuid::new_v4()));
        let error = run_once(&shared, &missing).expect_err("stopped run");
        assert!(
            error.to_string().contains("BACKGROUND_CHECKPOINT_STOPPED"),
            "the stop check must come before the open: {error}"
        );
    }

    /// 専用の接続は、最後の接続として閉じても `-wal` を消さない（対照：普通の接続は消す）。
    #[test]
    fn the_checkpoint_connection_never_removes_the_wal_when_it_closes_last() {
        let scenario = |dedicated: bool| {
            let (dir, path) = temp_db();
            let writer = Connection::open(&path).expect("writer");
            writer
                .execute_batch(
                    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
                     CREATE TABLE t (b BLOB); INSERT INTO t VALUES (zeroblob(8000));",
                )
                .expect("seed");
            let last = if dedicated {
                open_checkpoint_connection(&path).expect("dedicated")
            } else {
                Connection::open(&path).expect("plain")
            };
            let _: i64 = last
                .query_row("SELECT count(*) FROM t", [], |row| row.get(0))
                .expect("read");
            // writer を先に閉じる（最後の接続は `last`）。writer は autocheckpoint 0 だが、
            // 最後でないので close 時の checkpoint はしない。
            drop(writer);
            assert!(wal_of(&path).exists());
            drop(last);
            let remains = wal_of(&path).exists();
            let _ = std::fs::remove_dir_all(dir);
            remains
        };
        assert!(!scenario(false), "a plain last connection removes the WAL");
        assert!(
            scenario(true),
            "the dedicated connection must leave the WAL alone"
        );
    }
}
