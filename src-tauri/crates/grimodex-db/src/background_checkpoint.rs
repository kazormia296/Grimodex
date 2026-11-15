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
//!   `PRAGMA wal_checkpoint(PASSIVE)` を回して閉じる。この専用の接続は何も commit せず、
//!   TEMP 表・ReadIdentity・stamp にも関わらない（別の接続・別の TEMP）。PASSIVE は書き手も
//!   読み手も待たず、WAL の先頭へ戻す（restart）のは次の書き手が行う。
//! - **先払い（DR-DBC-6）**：PASSIVE が WAL を全部書き戻して終わった run の直後、背景の
//!   スレッドは**本体の接続の上で**、同値の `PRAGMA application_id` を 1 回 commit する
//!   （[`prepay`]）。WAL が全部書き戻されていると、次の書き手の最初の commit は WAL を先頭から
//!   書き直し（restart）、WAL header の書込みと fsync を払う（回転 HDD で約 45 ms）。それを
//!   前景の書き手でなく背景が先に払う。値は変わらず、schema・user_version・clock の
//!   seq（trigger が無い）・[`ReadIdentity`](crate::narrative_extraction::nir1_chronicle_index::read_identity::ReadIdentity)
//!   は動かない。
//!   - 取得は `ConnectionCore` の `try_lock_conn_with_check`（待たない。foreground の waiter・
//!     finalization の予約・quarantine・poison を既存の規則で見る）だけで、待つ `lock()` は
//!     使わない（hook の `enter_sync` が run の終了を待つので、待つ形にすると互いに待つ）。
//!     取れなければ何もしない（現状と同じく、次の書き手が払う）。
//!   - 別の接続では先払いしない。別の接続の commit は、前景の deferred transaction
//!     （`BEGIN; SELECT; INSERT`）を `SQLITE_BUSY_SNAPSHOT` で失敗させる（実測）。
//!   - `busy_timeout` は 0 にして commit し、`ConnectionCore::with_busy_timeout_on` が元へ戻す
//!     （戻せなければ既存の規則で接続を quarantine する）。
//!   - 先払いは `running = false` にした後で行う。先払いの commit が呼ぶ wal hook は、
//!     この thread の thread-local の旗（[`PrepayScope`]）で、page 数を記録するだけにする
//!     （`request()`・`enter_sync`・同期の checkpoint をしない）。読み手が WAL の先頭へ戻る
//!     のを止めていると先払いは restart せず frame を 1 つ足す（page 数が閾値以上になりうる）が、
//!     それで run が連鎖しない・4000 page 超でも自分の run や Mutex を待たない。
//!   - 失敗・飛ばしは `consecutive_failures` に数えない（先払いは最善努力で、無くても現状に
//!     戻るだけ）。成否は stats に数える（`prepay_restarted`／`prepay_not_restarted`／
//!     `prepay_skipped`／`prepay_failed`）。
//!   - **観測の変化**：`PRAGMA data_version` は**別の接続から見て** 1 回の先払いにつき動く。
//!     本体の接続の `PRAGMA data_version`・`total_changes`・schema_version・user_version・
//!     `ReadIdentity`（lineage・seq・schema_version・user_version）は動かない（試験で確かめる）。
//!     `SQLITE_FCNTL_DATA_VERSION`（`nir1_pinned_snapshot` の pin の鍵）は自分の commit でも動く
//!     が、pin はその接続が read snapshot を持つ間だけ答え、先払いは主接続が autocommit のとき
//!     しか commit しない（read transaction の中の接続には書かない）。別の接続の値は read
//!     transaction の中では動かない（SQLite の性質）。
//! - 背景が使えない間（止めた後・失敗が続いた後）は、hook が既定の autocheckpoint と
//!   同じ同期の checkpoint に戻る。上限の保証は失われない（このとき先払いはしない）。
//!
//! lifecycle：開く（`WorkspaceAuthority::new`）で始め、閉じる・workspace の切替え・
//! restore・recovery では `Database` の drop か明示の [`Database::stop_background_checkpoint`]
//! で止める。停止は、実行中の checkpoint を `sqlite3_interrupt` で中断し（待ちの間、打ち直す）、
//! 上限（[`STOP_WAIT`]）まで、スレッドの終了の証拠を待つ。先払いの commit（fsync）は中断できない
//! ので、停止の上限は変えない（約 45 ms。disk が止まれば長い）。
//!
//! 上限までに終了の証拠が取れない（`StopOutcome::TimedOut`）とき、restore は中止して
//! 元の authority を戻し、recovery の retire は `Err` を返す（fail-closed）。専用の接続は
//! `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE` で開くので、最後の接続として閉じても `-wal`／`-shm` を
//! 消さない。停止の要求の後は、専用の接続を新しく開かず、先払いも始めない（Mutex を取った
//! 後にもう一度確かめる）。
//!
//! 所有：スレッドは `Weak<ConnectionCore>` だけを持ち、先払いの間だけ upgrade する。`Database` の
//! drop は、背景を止めた後に**主接続を自分で閉じる**（`TimedOut` でスレッドがまだ upgrade した
//! `Arc` を持っていても、主接続の close と `-wal`／`-shm` の削除は drop が戻る前に済む）。
//!
//! 背景が追いつかないとき（commit が続く burst）の上限は [`MAX_WAL_PAGES_BEFORE_SYNC`]：
//! それ以上では hook が同期の checkpoint に戻る。

use std::cell::Cell;
use std::os::raw::{c_char, c_int, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rusqlite::{config::DbConfig, ffi, Connection, InterruptHandle, OpenFlags};

use crate::open_wal::{sqlite_wal_checkpoint, OpenWalCheckpointMode, WalCheckpointState};
use crate::{ConnectionCore, Database};

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
    /// 何本目の run か（`begin_run` が進める）。
    run_gen: u64,
    /// 同期の checkpoint が待ちを諦めた run の世代。その run が続く間は、上限を超えた commit が
    /// 二度と待たない（止まった背景に毎回 `SYNC_WAIT` を払わない）。
    abandoned_gen: Option<u64>,
    stop: bool,
    /// スレッドが終わった。
    exited: bool,
    /// run の PASSIVE が終わって `running` を下ろした後、先払いと run の結果の集計が終わるまで
    /// true（`wait_idle` が先払いの前に戻らないようにする。`enter_sync`・`begin_run` は見ない）。
    prepaying: bool,
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
    /// 同期の checkpoint が背景の run の終了を待ち切れず諦めた回数。
    sync_wait_timeouts: AtomicU64,
    last_log_frames: AtomicI64,
    /// 先払い（DR-DBC-6）の結果。PASSIVE が全部書き戻した run の後だけ commit する。
    /// restart まで済ませた（commit 後の WAL が 1 frame）。
    prepay_restarted: AtomicU64,
    /// commit したが restart されなかった（読み手が WAL の先頭へ戻るのを止めている）。
    prepay_not_restarted: AtomicU64,
    /// 条件を満たさない・取れない・止める途中などで何もしなかった。
    prepay_skipped: AtomicU64,
    /// commit が失敗した（`consecutive_failures` には数えない）。
    prepay_failed: AtomicU64,
    stop_wait_ms: AtomicU64,
    sync_wait_ms: AtomicU64,
    /// 試験用の注入点：true の間、run は停止の要求を無視して専用の接続を開く前で止まる。
    #[cfg(test)]
    stall: std::sync::atomic::AtomicBool,
    /// 試験用の注入点：true の間、run は専用の接続を開いて interrupt の handle を登録した後で止まる。
    #[cfg(test)]
    hold_after_open: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    holding: std::sync::atomic::AtomicBool,
    /// 試験用の注入点：true の間、先払いをしない（restart を前景が払う対照）。
    #[cfg(test)]
    prepay_disabled: std::sync::atomic::AtomicBool,
    /// 試験用の注入点：先払いが `PREPAY_HOLD_*` の位置で止まる（0 で解放）。
    #[cfg(test)]
    prepay_hold: AtomicU8,
    /// 試験用：先払いが今止まっている位置（0 は止まっていない）。
    #[cfg(test)]
    prepay_holding: AtomicU8,
}

/// 試験用：先払いの注入点の位置。
#[cfg(test)]
pub(crate) const PREPAY_HOLD_NONE: u8 = 0;
/// `Weak` を upgrade した後、Mutex を取る前（Mutex を握らない）。
#[cfg(test)]
pub(crate) const PREPAY_HOLD_BEFORE_LOCK: u8 = 1;
/// Mutex を握った後、commit の前（Mutex を握ったまま止まる）。
#[cfg(test)]
pub(crate) const PREPAY_HOLD_LOCKED: u8 = 2;

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
            sync_wait_timeouts: AtomicU64::new(0),
            last_log_frames: AtomicI64::new(-1),
            prepay_restarted: AtomicU64::new(0),
            prepay_not_restarted: AtomicU64::new(0),
            prepay_skipped: AtomicU64::new(0),
            prepay_failed: AtomicU64::new(0),
            #[cfg(test)]
            prepay_disabled: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            prepay_hold: AtomicU8::new(PREPAY_HOLD_NONE),
            #[cfg(test)]
            prepay_holding: AtomicU8::new(PREPAY_HOLD_NONE),
            stop_wait_ms: AtomicU64::new(u64::try_from(STOP_WAIT.as_millis()).unwrap_or(u64::MAX)),
            sync_wait_ms: AtomicU64::new(u64::try_from(SYNC_WAIT.as_millis()).unwrap_or(u64::MAX)),
            #[cfg(test)]
            stall: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            hold_after_open: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            holding: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn sync_wait(&self) -> Duration {
        Duration::from_millis(self.sync_wait_ms.load(Ordering::SeqCst))
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
            // 一度待ちを諦めた run には、もう待たない（その run が終わるまで）。
            if control.abandoned_gen == Some(control.run_gen) {
                return false;
            }
            let now = Instant::now();
            if now >= deadline {
                control.abandoned_gen = Some(control.run_gen);
                self.sync_wait_timeouts.fetch_add(1, Ordering::SeqCst);
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
        // 先払いの commit が呼んだ hook（この thread の thread-local の旗）。page 数を記録する
        // だけで、`request()`・`enter_sync`・同期の checkpoint をしない（B.2-6。読み手が restart を
        // 止めていて page 数が閾値以上でも、run が連鎖せず、自分の run を待たない）。
        if PREPAY_PAGES.with(Cell::get).is_some() {
            PREPAY_PAGES.with(|cell| cell.set(Some(i64::from(pages))));
            return;
        }
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
        // 「書き手が始まる時に全部書き戻し済み」のときだけ）ので、この待ち（最大 `SYNC_WAIT`。止まった run には一度だけ）が、
        // 前景への唯一の back-pressure になる。
        let requested = shared.request();
        let over_limit = i64::from(pages) >= MAX_WAL_PAGES_BEFORE_SYNC;
        if !requested || over_limit {
            let entered = over_limit && shared.enter_sync(shared.sync_wait());
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
    control.run_gen += 1;
    true
}

thread_local! {
    /// この thread が先払いの commit の中にいる間 `Some`。値は、直近の wal hook が受け取った
    /// page 数（まだ hook が呼ばれていなければ -1）。
    static PREPAY_PAGES: Cell<Option<i64>> = const { Cell::new(None) };
}

/// 先払いの commit の間だけ、wal hook を「記録するだけ」にする（drop で必ず戻す）。
struct PrepayScope;

impl PrepayScope {
    fn enter() -> Self {
        PREPAY_PAGES.with(|cell| cell.set(Some(-1)));
        Self
    }

    fn pages(&self) -> i64 {
        PREPAY_PAGES.with(Cell::get).unwrap_or(-1)
    }
}

impl Drop for PrepayScope {
    fn drop(&mut self) {
        PREPAY_PAGES.with(|cell| cell.set(None));
    }
}

/// `Control::prepaying` を、先払いと run の結果の集計が終わる（`return`・panic を含む）まで立てる。
struct PrepayingFlag<'a>(&'a Shared);

impl Drop for PrepayingFlag<'_> {
    fn drop(&mut self) {
        lock(&self.0.control).prepaying = false;
        self.0.wake.notify_all();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PrepayOutcome {
    /// commit し、WAL が先頭へ戻った。
    Restarted,
    /// commit したが、読み手が止めていて WAL は先頭へ戻らなかった。
    NotRestarted,
    Skipped(&'static str),
    Failed,
}

/// PASSIVE が全部書き戻した run の後だけ先払いする（restart が保留されているときだけ意味がある）。
fn prepay_eligible(state: &WalCheckpointState) -> bool {
    state.busy == 0 && state.checkpointed_frames == state.log_frames && state.log_frames > 0
}

/// 先払い（DR-DBC-6）。`running = false` にした後、スレッドが 1 回の run につき最大 1 回行う。
/// 本体の接続を `try_lock_conn_with_check` で取れたときだけ、`busy_timeout` 0 で
/// `BEGIN IMMEDIATE; PRAGMA application_id=<現在値>; COMMIT` を行う。
fn prepay(
    shared: &Shared,
    weak: &Weak<ConnectionCore>,
    state: &WalCheckpointState,
) -> PrepayOutcome {
    #[cfg(test)]
    if shared.prepay_disabled.load(Ordering::SeqCst) {
        return PrepayOutcome::Skipped("disabled");
    }
    if !prepay_eligible(state) {
        return PrepayOutcome::Skipped("not-fully-written-back");
    }
    if shared.stop_requested() || shared.mode.load(Ordering::SeqCst) != MODE_RUNNING {
        return PrepayOutcome::Skipped("stopping");
    }
    let Some(core) = weak.upgrade() else {
        return PrepayOutcome::Skipped("connection-gone");
    };
    #[cfg(test)]
    prepay_hold_at(shared, PREPAY_HOLD_BEFORE_LOCK);
    // 停止・foreground の waiter は、Mutex を取る前と取った後の両方で確かめる（check は
    // `try_lock_conn_with_check` が前後で呼ぶ）。Mutex を取った後の stop の確認が、drop が
    // 接続を差し替えた後に書かないことを保証する。
    let mut check = || -> anyhow::Result<()> {
        anyhow::ensure!(
            !shared.stop_requested() && shared.mode.load(Ordering::SeqCst) == MODE_RUNNING,
            "BACKGROUND_PREPAY_STOPPING"
        );
        anyhow::ensure!(
            core.foreground_connection_waiters.load(Ordering::SeqCst) == 0,
            "BACKGROUND_PREPAY_FOREGROUND_WAITING"
        );
        Ok(())
    };
    let guard = match core
        .try_lock_conn_with_check(Some(&mut check as &mut dyn FnMut() -> anyhow::Result<()>))
    {
        Ok(Some(guard)) => guard,
        Ok(None) => return PrepayOutcome::Skipped("connection-busy"),
        Err(_) => return PrepayOutcome::Skipped("not-acquirable"),
    };
    if !guard.is_autocommit() {
        return PrepayOutcome::Skipped("in-transaction");
    }
    #[cfg(test)]
    prepay_hold_at(shared, PREPAY_HOLD_LOCKED);
    // guard より後に宣言する（guard より先に drop され、guard の間に hook が戻る）。
    let scope = PrepayScope::enter();
    let result = catch_unwind(AssertUnwindSafe(|| {
        core.with_busy_timeout_on(&guard, Duration::ZERO, same_value_application_id_commit)
    }));
    let pages = scope.pages();
    drop(scope);
    let outcome = match result {
        Ok(Ok(())) if pages == 1 => PrepayOutcome::Restarted,
        Ok(Ok(())) => PrepayOutcome::NotRestarted,
        Ok(Err(error)) => {
            tracing::warn!("WAL restart prepay failed: {error}");
            PrepayOutcome::Failed
        }
        Err(_) => {
            // panic は、この共有の接続にとって terminal（maintenance の panic と同じ規則）。
            core.quarantine_connection("WAL restart prepay panicked");
            PrepayOutcome::Failed
        }
    };
    if !guard.is_autocommit() {
        // 失敗の後始末で ROLLBACK できていない接続を、guard を放す前に使えない状態にする。
        core.quarantine_connection("WAL restart prepay left a transaction open");
    }
    drop(guard);
    outcome
}

/// `application_id` に今の値を書き直す（同値でも page 1 が dirty になり、1 frame の commit になる）。
/// 失敗したら、開いた transaction を ROLLBACK する。
fn same_value_application_id_commit(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let write = (|| -> anyhow::Result<()> {
        let id: i64 = conn.pragma_query_value(None, "application_id", |row| row.get(0))?;
        conn.execute_batch(&format!("PRAGMA application_id={id}"))?;
        conn.execute_batch("COMMIT")?;
        Ok(())
    })();
    if write.is_err() && !conn.is_autocommit() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    write
}

#[cfg(test)]
fn prepay_hold_at(shared: &Shared, position: u8) {
    if shared.prepay_hold.load(Ordering::SeqCst) != position {
        return;
    }
    shared.prepay_holding.store(position, Ordering::SeqCst);
    while shared.prepay_hold.load(Ordering::SeqCst) == position {
        std::thread::sleep(Duration::from_millis(1));
    }
    shared
        .prepay_holding
        .store(PREPAY_HOLD_NONE, Ordering::SeqCst);
}

fn count_prepay(shared: &Shared, outcome: PrepayOutcome) {
    let counter = match outcome {
        PrepayOutcome::Restarted => &shared.prepay_restarted,
        PrepayOutcome::NotRestarted => &shared.prepay_not_restarted,
        PrepayOutcome::Skipped(_) => &shared.prepay_skipped,
        PrepayOutcome::Failed => &shared.prepay_failed,
    };
    counter.fetch_add(1, Ordering::SeqCst);
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
    #[cfg(test)]
    if shared.hold_after_open.load(Ordering::SeqCst) {
        shared.holding.store(true, Ordering::SeqCst);
        while shared.hold_after_open.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        shared.holding.store(false, Ordering::SeqCst);
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

fn checkpointer_main(shared: Arc<Shared>, db_path: PathBuf, core: Weak<ConnectionCore>) {
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
        // `running` を下ろすのと同じ critical section で `prepaying` を立てる（`wait_idle` が
        // 先払いの前に戻らない）。先払いは `running = false` の後なので、wal hook が
        // `enter_sync` で自分の run を待つことは構造的に起きない。
        let _prepaying = {
            let mut control = lock(&shared.control);
            control.running = false;
            control.prepaying = true;
            PrepayingFlag(&shared)
        };
        shared.wake.notify_all();
        let prepaid = match &result {
            Ok(state) => Some(prepay(&shared, &core, state)),
            Err(_) => None,
        };
        if let Some(outcome) = prepaid {
            count_prepay(&shared, outcome);
        }
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
    pub(crate) sync_wait_timeouts: u64,
    pub(crate) last_log_frames: i64,
    pub(crate) prepay_restarted: u64,
    pub(crate) prepay_not_restarted: u64,
    pub(crate) prepay_skipped: u64,
    pub(crate) prepay_failed: u64,
}

impl BackgroundCheckpointer {
    fn spawn(db_path: PathBuf, threshold: i64, core: Weak<ConnectionCore>) -> anyhow::Result<Self> {
        let shared = Arc::new(Shared::new(threshold));
        let thread_shared = Arc::clone(&shared);
        let handle = std::thread::Builder::new()
            .name("grimodex-wal-checkpoint".to_string())
            .spawn(move || checkpointer_main(thread_shared, db_path, core))?;
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
            sync_wait_timeouts: self.shared.sync_wait_timeouts.load(Ordering::SeqCst),
            last_log_frames: self.shared.last_log_frames.load(Ordering::SeqCst),
            prepay_restarted: self.shared.prepay_restarted.load(Ordering::SeqCst),
            prepay_not_restarted: self.shared.prepay_not_restarted.load(Ordering::SeqCst),
            prepay_skipped: self.shared.prepay_skipped.load(Ordering::SeqCst),
            prepay_failed: self.shared.prepay_failed.load(Ordering::SeqCst),
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
        while control.pending || control.running || control.prepaying {
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

    pub(crate) fn set_hold_after_open(&self, hold: bool) {
        self.shared.hold_after_open.store(hold, Ordering::SeqCst);
    }

    pub(crate) fn wait_holding(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.shared.holding.load(Ordering::SeqCst) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        false
    }

    pub(crate) fn set_sync_wait(&self, wait: Duration) {
        self.shared.sync_wait_ms.store(
            u64::try_from(wait.as_millis()).unwrap_or(u64::MAX),
            Ordering::SeqCst,
        );
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

    pub(crate) fn set_prepay_disabled(&self, disabled: bool) {
        self.shared
            .prepay_disabled
            .store(disabled, Ordering::SeqCst);
    }

    /// 先払いを `PREPAY_HOLD_*` の位置で止める（`PREPAY_HOLD_NONE` で解放）。
    pub(crate) fn set_prepay_hold(&self, position: u8) {
        self.shared.prepay_hold.store(position, Ordering::SeqCst);
    }

    pub(crate) fn wait_prepay_holding(&self, position: u8, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.shared.prepay_holding.load(Ordering::SeqCst) == position {
                return true;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        false
    }

    /// 先払いの 4 つの計数（restarted, not_restarted, skipped, failed）。
    pub(crate) fn prepay_counts(&self) -> (u64, u64, u64, u64) {
        (
            self.shared.prepay_restarted.load(Ordering::SeqCst),
            self.shared.prepay_not_restarted.load(Ordering::SeqCst),
            self.shared.prepay_skipped.load(Ordering::SeqCst),
            self.shared.prepay_failed.load(Ordering::SeqCst),
        )
    }

    pub(crate) fn sync_fallbacks(&self) -> u64 {
        self.shared.sync_fallbacks.load(Ordering::SeqCst)
    }

    pub(crate) fn sync_wait_timeouts(&self) -> u64 {
        self.shared.sync_wait_timeouts.load(Ordering::SeqCst)
    }

    pub(crate) fn is_pending(&self) -> bool {
        lock(&self.shared.control).pending
    }

    /// 停止の要求が立ったか（`stop` が slot を握ったまま待つので、stats の代わりに使う）。
    pub(crate) fn stop_requested(&self) -> bool {
        self.shared.stop_requested()
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
        let checkpointer = BackgroundCheckpointer::spawn(
            PathBuf::from(path),
            WAL_CHECKPOINT_PAGES,
            Arc::downgrade(&self.core),
        )?;
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
        let started = {
            let slot = lock(&self.background_checkpoint);
            match slot.as_ref() {
                Some(checkpointer) => {
                    checkpointer.stop(checkpointer.shared.stop_wait());
                    true
                }
                None => false,
            }
        };
        if started {
            self.close_connection_after_background_stop();
        }
    }
}

impl Database {
    /// 背景を止めた後、主接続を自分で閉じる（DR-DBC-6）。`stop` が `TimedOut` のとき、スレッドは
    /// 先払いのために upgrade した `Arc<ConnectionCore>` を持ったまま残りうる。drop の後に最後の
    /// `Arc` がスレッド側で落ちると、接続の close と `-wal`／`-shm` の削除が drop より後になる
    /// （open の quiesce・restore が、drop の後に同じ file を扱う）。それを避けるため、retire と同じく
    /// Mutex の下で `mem::replace` で実接続を取り出し、自分で close する。
    ///
    /// - 先払いがその最中に Mutex を握っていれば、その commit（fsync 1 回）が終わるまで待つ。
    ///   先払いは Mutex を `try_lock` でだけ取るので、互いに待つことは無い。
    /// - 差し替えの後に先払いが Mutex を取れても、`stop` の要求を取得の後に確かめるので書かない。
    ///   念のため、接続を使えない状態（quarantine）にしておく。
    /// - 背景を始めていない接続（standalone MCP の `from_connection` など）には何もしない。
    fn close_connection_after_background_stop(&self) {
        let mut conn = self
            .core
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.core
            .quarantine_connection("closed by Database drop after the background stop");
        let Ok(replacement) = Connection::open_in_memory() else {
            return;
        };
        let retired = std::mem::replace(&mut *conn, replacement);
        drop(conn);
        // 失敗は drop と同じく捨てる（返ってきた接続の drop が最後の手段）。
        let _ = retired.close();
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
