//! DR-DBC-1／DR-DBC-6: 背景の WAL checkpoint の lifecycle・上限・識別と、
//! 書戻しの後の WAL の restart の先払いの試験。

use super::background_checkpoint::{
    BackgroundCheckpointMode, BackgroundCheckpointProbe, BackgroundCheckpointStart, StopOutcome,
    MAX_WAL_PAGES_BEFORE_SYNC, PREPAY_HOLD_AFTER_LOCK, PREPAY_HOLD_BEFORE_LOCK, PREPAY_HOLD_LOCKED,
    PREPAY_HOLD_NONE, WAL_CHECKPOINT_PAGES,
};
use super::narrative_extraction::nir1_chronicle_index::read_identity::ReadIdentity;
use super::open_wal::{sqlite_wal_checkpoint, OpenWalCheckpointMode, OpenWalPreparationOutcome};
use super::{read_db_clock, Database};
use std::path::{Path, PathBuf};
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(20);

struct Fixture {
    dir: PathBuf,
    path: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-bg-checkpoint-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create fixture dir");
        let path = dir.join("grimodex.db");
        Self { dir, path }
    }

    /// 開いて、payload 表を作り、WAL を畳んでおく。背景は始めない。
    fn open(&self) -> Database {
        if !self.path.exists() {
            // 小さい page（1 KiB）で作る：同じ page 数でも一時領域の使用量が 1/4 で済む
            // （この環境の /tmp には約 300 MB の容量制限がある）。page size は最初の表の前に決める。
            let conn = rusqlite::Connection::open(&self.path).expect("create fixture");
            conn.execute_batch("PRAGMA page_size=1024; PRAGMA journal_mode=WAL;")
                .expect("small pages");
        }
        let db = Database::new(&self.path).expect("open fixture");
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS payload (id INTEGER PRIMARY KEY, body BLOB NOT NULL);",
            )?;
            Ok(())
        })
        .expect("create payload table");
        db.with_conn(|conn| {
            sqlite_wal_checkpoint(conn, OpenWalCheckpointMode::Restart)?;
            Ok(())
        })
        .expect("start from a clean WAL");
        db
    }

    fn wal_path(&self) -> PathBuf {
        let mut name = self.path.as_os_str().to_owned();
        name.push("-wal");
        PathBuf::from(name)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// 1 transaction で、おおよそ `rows` page を WAL に書く。
fn append_pages(db: &Database, rows: i64) {
    db.with_conn(|conn| {
        conn.execute(
            "WITH RECURSIVE seq(n) AS (
                 SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?1
             )
             INSERT INTO payload (body) SELECT zeroblob(700) FROM seq",
            [rows],
        )?;
        Ok(())
    })
    .expect("append pages");
}

fn wal_state(db: &Database) -> crate::open_wal::WalCheckpointState {
    db.with_conn(|conn| Ok(sqlite_wal_checkpoint(conn, OpenWalCheckpointMode::Noop)?))
        .expect("inspect WAL")
}

fn started(db: &Database) -> BackgroundCheckpointProbe {
    assert_eq!(
        db.start_background_checkpoint().expect("start"),
        BackgroundCheckpointStart::Started
    );
    db.background_checkpoint_probe().expect("probe")
}

fn pragma_autocheckpoint(db: &Database) -> i64 {
    db.with_conn(|conn| Ok(conn.pragma_query_value(None, "wal_autocheckpoint", |row| row.get(0))?))
        .expect("read autocheckpoint")
}

/// `-wal` の header の（checkpoint の通番、salt-1、salt-2）。restart の後、最初の frame を書く接続が
/// 書き直すので、「誰が restart したか」を記憶媒体の速さに依らず決定的に見られる。
fn wal_header(fixture: &Fixture) -> (u32, u32, u32) {
    use std::io::Read;
    let mut file = std::fs::File::open(fixture.wal_path()).expect("open the WAL");
    let mut header = [0_u8; 32];
    file.read_exact(&mut header).expect("read the WAL header");
    let word = |at: usize| u32::from_be_bytes(header[at..at + 4].try_into().expect("4 bytes"));
    (word(12), word(16), word(20))
}

/// 手動で 1 回走らせ、その先払いまでの終了を待つ（`runs` は先払いの集計の後に進む）。
fn run_and_settle(probe: &BackgroundCheckpointProbe) {
    let before = probe.stats_runs();
    probe.request_run();
    assert!(
        probe.wait_runs_at_least(before + 1, WAIT),
        "run must finish"
    );
    assert!(probe.wait_idle(WAIT), "prepay must settle");
}

#[test]
fn the_threshold_is_the_existing_autocheckpoint_default() {
    let fixture = Fixture::new("threshold");
    let db = fixture.open();
    // `Database::new` の `PRAGMA wal_autocheckpoint=1000` と同じ値を保つ（値は変えない）。
    assert_eq!(pragma_autocheckpoint(&db), WAL_CHECKPOINT_PAGES);
    assert_eq!(WAL_CHECKPOINT_PAGES, 1_000);
}

#[test]
fn start_takes_over_from_autocheckpoint_and_is_not_applicable_elsewhere() {
    let fixture = Fixture::new("start");
    let db = fixture.open();
    assert_eq!(db.background_checkpoint_threshold(), None);
    let _probe = started(&db);
    assert_eq!(
        pragma_autocheckpoint(&db),
        0,
        "the hook replaced autocheckpoint"
    );
    assert_eq!(
        db.background_checkpoint_threshold(),
        Some(WAL_CHECKPOINT_PAGES)
    );
    assert_eq!(
        db.start_background_checkpoint().expect("second start"),
        BackgroundCheckpointStart::AlreadyRunning
    );

    let memory = Database::new(Path::new(":memory:")).expect("memory db");
    assert_eq!(
        memory.start_background_checkpoint().expect("memory start"),
        BackgroundCheckpointStart::NotApplicable("not-file-backed")
    );
    assert_eq!(pragma_autocheckpoint(&memory), WAL_CHECKPOINT_PAGES);
    assert!(memory.background_checkpoint_threshold().is_none());

    let read_only_conn = rusqlite::Connection::open_with_flags(
        &fixture.path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("read-only connection");
    let reader = Database::from_connection(read_only_conn);
    assert_eq!(
        reader
            .start_background_checkpoint()
            .expect("read-only start"),
        BackgroundCheckpointStart::NotApplicable("read-only")
    );
}

/// 対照：背景も autocheckpoint も無ければ WAL は伸び続ける。背景があれば、閾値の近くに保たれる。
#[test]
fn background_checkpoint_keeps_the_wal_near_the_threshold() {
    const COMMITS: usize = 60;
    const ROWS: i64 = 150;

    let control_fixture = Fixture::new("wal-control");
    let control = control_fixture.open();
    control
        .with_conn(|conn| {
            conn.pragma_update(None, "wal_autocheckpoint", 0)?;
            Ok(())
        })
        .expect("disable autocheckpoint");
    let mut control_max = 0;
    for _ in 0..COMMITS {
        append_pages(&control, ROWS);
        control_max = control_max.max(wal_state(&control).log_frames);
    }
    assert!(
        control_max > 4 * WAL_CHECKPOINT_PAGES,
        "without any checkpoint the WAL must grow well past the threshold: {control_max}"
    );

    let fixture = Fixture::new("wal-bounded");
    let db = fixture.open();
    let probe = started(&db);
    let mut max_frames = 0;
    for _ in 0..COMMITS {
        append_pages(&db, ROWS);
        // commit の中で hook が「回せ」と知らせている。背景が終わるのを待ってから測る。
        assert!(probe.wait_idle(WAIT), "background checkpoint must settle");
        max_frames = max_frames.max(wal_state(&db).log_frames);
    }
    let stats = db.background_checkpoint_stats().expect("stats");
    assert_eq!(stats.mode, BackgroundCheckpointMode::Running);
    assert!(stats.runs >= 1, "the background connection must have run");
    assert_eq!(stats.failures, 0);
    // 閾値＋最後の 1 transaction ぶん（index・overflow の余裕を含む）。
    assert!(
        max_frames <= WAL_CHECKPOINT_PAGES + 2 * ROWS,
        "WAL must stay near the threshold, saw {max_frames} frames"
    );
    assert!(max_frames < control_max / 3);
    let integrity: String = db
        .with_conn(|conn| Ok(conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?))
        .expect("integrity");
    assert_eq!(integrity, "ok");
}

/// 大きい commit の書戻しは、背景の接続（別 thread）が PASSIVE で行い、その後の WAL の restart
/// （header の書直しと fsync）は、前景でなく背景のスレッドが先払いする（DR-DBC-6）。
#[test]
fn a_large_commit_is_written_back_and_restarted_by_the_background_thread() {
    let fixture = Fixture::new("not-inline");
    let db = fixture.open();
    let probe = started(&db);
    let before = probe.stats_runs();
    // 背景の run を止めておき、前景の commit が書いた header を先に取る。
    probe.set_stall(true);
    append_pages(&db, 3 * WAL_CHECKPOINT_PAGES);
    let foreground_header = wal_header(&fixture);
    probe.set_stall(false);
    assert!(probe.wait_runs_at_least(before + 1, WAIT));
    assert!(probe.wait_idle(WAIT));

    let stats = db.background_checkpoint_stats().expect("stats");
    assert!(
        stats.last_log_frames >= 3 * WAL_CHECKPOINT_PAGES,
        "the PASSIVE run saw the whole commit: {stats:?}"
    );
    assert_eq!(
        (
            stats.prepay_restarted,
            stats.prepay_not_restarted,
            stats.prepay_skipped,
            stats.prepay_failed
        ),
        (1, 0, 0, 0),
        "PASSIVE wrote everything back, so the background restarted the WAL: {stats:?}"
    );
    // restart の証拠：WAL が先頭へ戻り（1 frame）、header の通番と salt が背景の commit で変わった。
    let state = wal_state(&db);
    assert_eq!(state.log_frames, 1, "the WAL was restarted: {state:?}");
    assert_eq!(state.checkpointed_frames, 0);
    let background_header = wal_header(&fixture);
    assert_eq!(background_header.0, foreground_header.0 + 1);
    assert_ne!(background_header.1, foreground_header.1);
    let rows: i64 = db
        .with_conn(|conn| Ok(conn.query_row("SELECT count(*) FROM payload", [], |row| row.get(0))?))
        .expect("count");
    assert_eq!(rows, 3 * WAL_CHECKPOINT_PAGES);
    // 先払いの commit は hook を呼ぶが run を起こさない（連鎖しない）。
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(probe.stats_runs(), before + 1);
    assert!(!probe.is_pending());
}

/// 次の前景の commit は restart を払わない（header を書き直さない）。先払いを止めた対照では、
/// 前景の最初の commit が header を書き直す。記憶媒体の速さに依らない決定的な確認。
#[test]
fn the_next_foreground_commit_does_not_restart_the_wal_after_a_prepay() {
    let scenario = |prepay: bool| {
        let fixture = Fixture::new(if prepay { "prepay-on" } else { "prepay-off" });
        let db = fixture.open();
        let probe = started(&db);
        probe.set_prepay_disabled(!prepay);
        probe.set_stall(true);
        append_pages(&db, 2 * WAL_CHECKPOINT_PAGES);
        let before_run = wal_header(&fixture);
        probe.set_stall(false);
        assert!(probe.wait_runs_at_least(1, WAIT));
        assert!(probe.wait_idle(WAIT));
        let after_run = wal_header(&fixture);
        // 前景の次の commit（閾値未満なので run は起きない）。
        append_pages(&db, 5);
        let after_foreground = wal_header(&fixture);
        (before_run, after_run, after_foreground)
    };
    let (before_run, after_run, after_foreground) = scenario(true);
    assert_ne!(after_run, before_run, "the background rewrote the header");
    assert_eq!(
        after_foreground, after_run,
        "the foreground commit appended without restarting the WAL"
    );
    let (before_run, after_run, after_foreground) = scenario(false);
    assert_eq!(
        after_run, before_run,
        "control: nothing restarted the WAL yet"
    );
    assert_ne!(
        after_foreground, after_run,
        "control: without the prepay the foreground commit restarts the WAL"
    );
}

/// 先払いは、値（`application_id`・`user_version`・`schema_version`・clock の seq・ReadIdentity）と
/// 本体の接続の `data_version`・`total_changes` を動かさない。別の接続の `data_version` は動く（陽性の対照）。
#[test]
fn a_prepay_changes_no_value_and_no_counter_of_the_main_connection() {
    let fixture = Fixture::new("prepay-invariants");
    let db = fixture.open();
    db.with_conn(|conn| {
        conn.execute_batch("PRAGMA application_id=1234567; PRAGMA user_version=7;")?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        crate::write_clock::install_write_clock_in_tx(conn)?;
        conn.execute_batch("COMMIT")?;
        Ok(())
    })
    .expect("seed the header values and the write clock");
    let probe = started(&db);
    let observer = rusqlite::Connection::open(&fixture.path).expect("observer");
    let observed_version = |conn: &rusqlite::Connection| -> i64 {
        conn.query_row("PRAGMA data_version", [], |row| row.get(0))
            .expect("observer data_version")
    };
    let main_values = |db: &Database| {
        db.with_conn(|conn| {
            let pragma = |name: &str| -> i64 {
                conn.pragma_query_value(None, name, |row| row.get(0))
                    .expect("pragma")
            };
            Ok((
                pragma("data_version"),
                conn.total_changes(),
                pragma("schema_version"),
                pragma("user_version"),
                pragma("application_id"),
                read_db_clock(conn)?,
                ReadIdentity::read_unpinned(conn)?,
            ))
        })
        .expect("main connection values")
    };

    probe.set_stall(true);
    append_pages(&db, 2 * WAL_CHECKPOINT_PAGES);
    let baseline = main_values(&db);
    let observer_before = observed_version(&observer);
    probe.set_stall(false);
    assert!(probe.wait_runs_at_least(1, WAIT));
    assert!(probe.wait_idle(WAIT));
    assert_eq!(
        db.background_checkpoint_stats()
            .expect("stats")
            .prepay_restarted,
        1
    );
    assert_eq!(
        main_values(&db),
        baseline,
        "a prepay is invisible to the main connection"
    );
    assert_eq!(baseline.4, 1_234_567, "the value was written back as is");
    let observer_after = observed_version(&observer);
    assert_ne!(
        observer_after, observer_before,
        "control: another connection does see a commit"
    );

    // 2 回目（WAL は 1 frame・書戻し済み）も同じ。
    run_and_settle(&probe);
    assert_eq!(
        db.background_checkpoint_stats()
            .expect("stats")
            .prepay_restarted,
        2
    );
    assert_eq!(main_values(&db), baseline);
    assert_ne!(observed_version(&observer), observer_after);
}

/// 先払いは、前景の deferred transaction を失敗させない（別の接続で commit する案は、
/// `SQLITE_BUSY_SNAPSHOT` で失敗した）。先払いが何度も走る間、前景の
/// `BEGIN; SELECT; INSERT; COMMIT` はすべて成功する。
#[test]
fn a_prepay_never_fails_a_foreground_deferred_transaction() {
    let fixture = Fixture::new("prepay-deferred");
    let db = std::sync::Arc::new(fixture.open());
    let probe = started(&db);
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let db = std::sync::Arc::clone(&db);
        let done = std::sync::Arc::clone(&done);
        std::thread::spawn(move || {
            let mut failures = Vec::new();
            for index in 0..400 {
                let result = db.with_conn(|conn| {
                    conn.execute_batch("BEGIN")?;
                    let _: i64 =
                        conn.query_row("SELECT count(*) FROM payload", [], |row| row.get(0))?;
                    conn.execute("INSERT INTO payload (body) VALUES (zeroblob(3000))", [])?;
                    conn.execute_batch("COMMIT")?;
                    Ok(())
                });
                if let Err(error) = result {
                    failures.push(format!("commit {index}: {error}"));
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            done.store(true, std::sync::atomic::Ordering::SeqCst);
            failures
        })
    };
    let deadline = std::time::Instant::now() + WAIT;
    while !done.load(std::sync::atomic::Ordering::SeqCst) && std::time::Instant::now() < deadline {
        probe.request_run();
        std::thread::sleep(Duration::from_millis(15));
    }
    let failures = writer.join().expect("writer thread");
    assert!(failures.is_empty(), "foreground failures: {failures:?}");
    assert!(probe.wait_idle(WAIT));
    // writer が終わった後に 1 回、決定的に走らせる（writer の間に先払いが 1 回も起きなかった
    // 場合でも、先払いが起き、失敗しないことを確かめる）。writer は join 済みで waiter・transaction
    // は無く、WAL には writer の frame が残っているので、PASSIVE は全部書き戻し、先払いは commit する。
    run_and_settle(&probe);
    let stats = db.background_checkpoint_stats().expect("stats");
    assert_eq!(stats.failures, 0);
    assert_eq!(stats.prepay_failed, 0, "{stats:?}");
    assert!(
        stats.prepay_restarted + stats.prepay_not_restarted >= 1,
        "a prepay must have happened: {stats:?}"
    );
}

/// 先払いを飛ばす条件。どれも commit が起きず、`prepay_skipped` だけが増え、背景は Running のまま。
#[test]
fn a_prepay_is_skipped_unless_it_can_be_made_without_waiting() {
    let fixture = Fixture::new("prepay-skip");
    let db = fixture.open();
    let probe = started(&db);
    append_pages(&db, 400);
    let skipped = |expected: u64| {
        let stats = db.background_checkpoint_stats().expect("stats");
        assert_eq!(stats.mode, BackgroundCheckpointMode::Running);
        assert_eq!(
            (
                stats.prepay_restarted,
                stats.prepay_not_restarted,
                stats.prepay_failed
            ),
            (0, 0, 0)
        );
        assert_eq!(stats.prepay_skipped, expected, "{stats:?}");
    };

    // 本体の接続が explicit transaction の中（別の呼び出しをまたぐ BEGIN）。
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN")?;
        let _: i64 = conn.query_row("SELECT count(*) FROM payload", [], |row| row.get(0))?;
        Ok(())
    })
    .expect("open a deferred transaction on the main connection");
    run_and_settle(&probe);
    skipped(1);
    db.with_conn(|conn| {
        conn.execute("INSERT INTO payload (body) VALUES (zeroblob(10))", [])?;
        conn.execute_batch("COMMIT")?;
        Ok(())
    })
    .expect("the deferred transaction still commits");

    // 前景が Mutex を握っている（待たずに諦める）。
    {
        let held = db.lock_conn().expect("hold the main connection");
        let before = probe.stats_runs();
        probe.request_run();
        assert!(probe.wait_runs_at_least(before + 1, WAIT));
        assert!(probe.wait_idle(WAIT));
        drop(held);
    }
    skipped(2);

    // 前景が待っている（譲る）。
    {
        let _waiter = super::ForegroundConnectionWaiter::new(&db.foreground_connection_waiters);
        run_and_settle(&probe);
    }
    skipped(3);

    // 古い snapshot の読み手がいる（PASSIVE が全部は書き戻せない）。
    let reader = rusqlite::Connection::open(&fixture.path).expect("reader");
    reader.execute_batch("BEGIN").expect("begin");
    let _: i64 = reader
        .query_row("SELECT count(*) FROM payload", [], |row| row.get(0))
        .expect("pin the snapshot");
    append_pages(&db, 200);
    run_and_settle(&probe);
    skipped(4);
    let state = wal_state(&db);
    assert!(state.checkpointed_frames < state.log_frames, "{state:?}");
    drop(reader);

    // 全部が揃うと先払いする（対照）。
    run_and_settle(&probe);
    let stats = db.background_checkpoint_stats().expect("stats");
    assert_eq!(stats.prepay_restarted, 1, "{stats:?}");
    assert_eq!(stats.prepay_skipped, 4);
    assert_eq!(wal_state(&db).log_frames, 1);

    // 先払いを止める注入点（対照のための旗）。
    probe.set_prepay_disabled(true);
    append_pages(&db, 50);
    run_and_settle(&probe);
    assert_eq!(
        db.background_checkpoint_stats()
            .expect("stats")
            .prepay_skipped,
        5
    );
}

/// 先払いの失敗（別の接続が書込みの lock を持つ）は `consecutive_failures` に数えない：
/// 3 回を超えて続いても背景は Running のまま。`busy_timeout` は元の値に戻り、接続は使える。
#[test]
fn a_failed_prepay_is_not_a_checkpoint_failure_and_restores_the_busy_timeout() {
    let fixture = Fixture::new("prepay-failure");
    let db = fixture.open();
    let probe = started(&db);
    append_pages(&db, 300);
    let busy_timeout = |db: &Database| -> i64 {
        db.with_conn(|conn| Ok(conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))?))
            .expect("busy_timeout")
    };
    let configured = busy_timeout(&db);
    assert!(configured > 0);

    let other = rusqlite::Connection::open(&fixture.path).expect("other writer");
    other
        .execute_batch("BEGIN IMMEDIATE")
        .expect("hold the write lock");
    for _ in 0..5 {
        run_and_settle(&probe);
    }
    let stats = db.background_checkpoint_stats().expect("stats");
    assert_eq!(stats.prepay_failed, 5, "{stats:?}");
    assert_eq!(
        stats.failures, 0,
        "a prepay failure is not a checkpoint failure"
    );
    assert_eq!(
        stats.mode,
        BackgroundCheckpointMode::Running,
        "five failures in a row must not disable the background: {stats:?}"
    );
    assert_eq!(busy_timeout(&db), configured);
    assert!(db.connection_reusable());
    assert!(db.lock_conn().expect("lock").is_autocommit());
    other.execute_batch("ROLLBACK").expect("release");
    drop(other);

    run_and_settle(&probe);
    assert_eq!(
        db.background_checkpoint_stats()
            .expect("stats")
            .prepay_restarted,
        1
    );
}

/// 読み手が最新の snapshot を握ったまま WAL の先頭へ戻るのを止めている間、先払いは restart せず
/// frame を 1 つ足す（`not_restarted`）。そのとき hook は run を起こさない（連鎖しない）。読み手が去った後の
/// 次の commit で run が起き、先払いが restart する。
#[test]
fn a_prepay_that_cannot_restart_does_not_chain_runs() {
    let fixture = Fixture::new("prepay-reader");
    let db = fixture.open();
    let probe = started(&db);
    let runs0 = probe.stats_runs();
    probe.set_stall(true);
    append_pages(&db, WAL_CHECKPOINT_PAGES + 500);
    // 最新の frame を握る読み手（checkpoint の前の snapshot）。PASSIVE は止まらないが restart は止まる。
    let reader = rusqlite::Connection::open(&fixture.path).expect("reader");
    reader.execute_batch("BEGIN").expect("begin");
    let _: i64 = reader
        .query_row("SELECT count(*) FROM payload", [], |row| row.get(0))
        .expect("pin the latest snapshot");
    probe.set_stall(false);
    assert!(probe.wait_runs_at_least(runs0 + 1, WAIT));
    assert!(probe.wait_idle(WAIT));
    let stats = db.background_checkpoint_stats().expect("stats");
    assert_eq!(
        (stats.prepay_restarted, stats.prepay_not_restarted),
        (0, 1),
        "{stats:?}"
    );
    let frames_after_prepay = wal_state(&db).log_frames;
    assert_eq!(frames_after_prepay, stats.last_log_frames + 1);
    assert!(frames_after_prepay >= WAL_CHECKPOINT_PAGES);

    // 先払いの commit の page 数は閾値以上だが、run は連鎖しない。
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(probe.stats_runs(), runs0 + 1, "no chained run");
    assert!(!probe.is_pending());

    // 読み手が去り、前景の commit が閾値以上の hook で run を起こす。今度は restart する。
    reader.execute_batch("ROLLBACK").expect("rollback");
    drop(reader);
    append_pages(&db, 1);
    assert!(probe.wait_runs_at_least(runs0 + 2, WAIT));
    assert!(probe.wait_idle(WAIT));
    let stats = db.background_checkpoint_stats().expect("stats");
    assert_eq!(stats.prepay_restarted, 1, "{stats:?}");
    assert_eq!(wal_state(&db).log_frames, 1);
}

/// 4000 page を超える WAL を読み手が止めていても、先払いの commit の hook は同期の checkpoint にも
/// `enter_sync` にも入らず、Mutex を握ったまま待たない。
#[test]
fn a_prepay_over_the_hard_limit_never_waits_while_holding_the_connection() {
    let fixture = Fixture::new("prepay-over-limit");
    let db = fixture.open();
    let probe = started(&db);
    probe.set_sync_wait(Duration::from_millis(100));
    let runs0 = probe.stats_runs();
    probe.set_stall(true);
    append_pages(&db, MAX_WAL_PAGES_BEFORE_SYNC - 1_000);
    // 古い snapshot の読み手 A：次の commit が上限を超えたときの同期の checkpoint が全部を書き戻せない
    // ようにして、B が slot 1 以上の read mark を持てる（全部書き戻された後の新しい読み手は slot 0 を使い、
    // restart を止めない）状態を作る。
    let old_reader = rusqlite::Connection::open(&fixture.path).expect("old reader");
    old_reader.execute_batch("BEGIN").expect("begin");
    let _: i64 = old_reader
        .query_row("SELECT count(*) FROM payload", [], |row| row.get(0))
        .expect("pin the old snapshot");
    append_pages(&db, 1_200);
    // 読み手 B：最新の snapshot。A が去れば PASSIVE は全部書き戻せるが、restart は B が止める。
    let reader = rusqlite::Connection::open(&fixture.path).expect("reader");
    reader.execute_batch("BEGIN").expect("begin");
    let _: i64 = reader
        .query_row("SELECT count(*) FROM payload", [], |row| row.get(0))
        .expect("pin the latest snapshot");
    old_reader.execute_batch("ROLLBACK").expect("release A");
    drop(old_reader);
    let fallbacks = probe.sync_fallbacks();
    let timeouts = probe.sync_wait_timeouts();
    probe.set_stall(false);
    assert!(probe.wait_runs_at_least(runs0 + 1, WAIT));
    assert!(probe.wait_idle(WAIT));
    let stats = db.background_checkpoint_stats().expect("stats");
    assert_eq!(stats.prepay_not_restarted, 1, "{stats:?}");
    assert!(
        stats.last_log_frames + 1 >= MAX_WAL_PAGES_BEFORE_SYNC,
        "the prepay frame crossed the hard limit: {stats:?}"
    );
    assert_eq!(
        (probe.sync_fallbacks(), probe.sync_wait_timeouts()),
        (fallbacks, timeouts),
        "the prepay's own hook must not fall back to a synchronous checkpoint or wait"
    );
    // 先払いが終わったとき、前景は待たずに Mutex を取れる。
    assert!(db
        .try_lock_conn_with_check(None)
        .expect("acquire")
        .is_some());
    drop(reader);
}

/// 先払いが Mutex を握っている間（maintenance の no-wait guard が**無い瞬間**に先払いが握った場合）、
/// no-wait の呼び手（maintenance、nir1 store の try 経路）は待たずに譲り、前景の blocking の呼び手は
/// 終わるまで待って成功する（DR-DBC-6 の窓）。guard が生きている間は先払いがそもそも握らない
/// （下の 2 本）ので、この窓は guard が無い間に起きた先払いに限られる。
#[test]
fn callers_that_do_not_wait_yield_while_a_prepay_holds_the_connection() {
    let fixture = Fixture::new("prepay-window");
    let db = fixture.open();
    let probe = started(&db);
    append_pages(&db, 300);
    probe.set_prepay_hold(PREPAY_HOLD_LOCKED);
    probe.request_run();
    assert!(probe.wait_prepay_holding(PREPAY_HOLD_LOCKED, WAIT));

    {
        let _no_wait = db.enter_maintenance_connection_no_wait();
        let error = db.lock_conn().expect_err("maintenance must not wait");
        assert!(
            error
                .to_string()
                .contains("NEX_MAINTENANCE_CONNECTION_PREEMPTED"),
            "{error}"
        );
    }
    assert!(
        db.try_lock_conn_with_check(None)
            .expect("try acquisition")
            .is_none(),
        "the waiter-free acquisition (DR-MPS-15) reports busy"
    );
    std::thread::scope(|scope| {
        let blocked = scope.spawn(|| {
            db.with_conn(|conn| {
                let rows: i64 =
                    conn.query_row("SELECT count(*) FROM payload", [], |row| row.get(0))?;
                Ok(rows)
            })
        });
        // 呼び手が waiter として並んでから確かめる（待ちは、先払いを解放するまで終わらない）。
        let deadline = std::time::Instant::now() + WAIT;
        while db.foreground_connection_waiter_count() == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(db.foreground_connection_waiter_count(), 1);
        assert!(
            !blocked.is_finished(),
            "the blocking caller waits for the prepay"
        );
        probe.set_prepay_hold(PREPAY_HOLD_NONE);
        assert_eq!(blocked.join().expect("join").expect("read"), 300);
    });
    assert!(probe.wait_idle(WAIT));
    assert_eq!(
        db.background_checkpoint_stats()
            .expect("stats")
            .prepay_restarted,
        1
    );
}

/// maintenance の no-wait guard が生きている間は、先払いは本体の接続を握らず飛ばす（cycle の途中で
/// `NEX_MAINTENANCE_CONNECTION_PREEMPTED` に当たらない）。guard の drop の後は、同じ run の状態から
/// 先払いが行われる（RAII で数が戻る）。
#[test]
fn a_prepay_yields_while_a_maintenance_no_wait_guard_is_alive() {
    let fixture = Fixture::new("prepay-maintenance");
    let db = fixture.open();
    let probe = started(&db);
    append_pages(&db, 300);
    let header = wal_header(&fixture);
    {
        // この thread は no-wait mode になるので、guard の間は probe だけを触る（db を使わない）。
        let _no_wait = db.enter_maintenance_connection_no_wait();
        run_and_settle(&probe);
        run_and_settle(&probe);
        // (restarted, not_restarted, skipped, failed)
        assert_eq!(probe.prepay_counts(), (0, 0, 2, 0));
    }
    assert_eq!(wal_header(&fixture), header, "nothing was committed");
    // 別の guard が入れ子で生きている間も、1 つ drop しただけでは譲り続ける。
    let outer = db.enter_maintenance_connection_no_wait();
    drop(db.enter_maintenance_connection_no_wait());
    run_and_settle(&probe);
    assert_eq!(probe.prepay_counts(), (0, 0, 3, 0));
    drop(outer);
    run_and_settle(&probe);
    assert_eq!(probe.prepay_counts(), (1, 0, 3, 0));
    assert_ne!(wal_header(&fixture), header, "the prepay restarted the WAL");
}

/// 先払いが入口の確認の後・Mutex を取った後に maintenance の guard が入っても、取得の後の確認で
/// 譲る（Mutex は放し、何も commit しない）。
#[test]
fn a_maintenance_guard_that_enters_after_the_prepay_took_the_connection_makes_it_yield() {
    let fixture = Fixture::new("prepay-maintenance-after-lock");
    let db = fixture.open();
    let probe = started(&db);
    append_pages(&db, 300);
    let header = wal_header(&fixture);
    probe.set_prepay_hold(PREPAY_HOLD_AFTER_LOCK);
    probe.request_run();
    assert!(probe.wait_prepay_holding(PREPAY_HOLD_AFTER_LOCK, WAIT));
    let no_wait = db.enter_maintenance_connection_no_wait();
    probe.set_prepay_hold(PREPAY_HOLD_NONE);
    assert!(probe.wait_idle(WAIT));
    assert_eq!(probe.prepay_counts(), (0, 0, 1, 0));
    drop(no_wait);
    assert_eq!(wal_header(&fixture), header, "nothing was committed");
    // 譲った後に Mutex が放されている（前景の取得が通る）。
    db.with_conn(|conn| Ok(conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?))
        .expect("the connection was released");
}

/// 停止の要求が、先払いが Mutex を取った**後**に来ても、取得の後の確認で飛ばして何も書かない
/// （入口の確認では捕まらない位置。取得の後の確認を外すと落ちる）。
#[test]
fn a_stop_that_arrives_after_the_prepay_took_the_connection_skips_it() {
    let fixture = Fixture::new("prepay-stop-after-lock");
    let db = fixture.open();
    let probe = started(&db);
    append_pages(&db, 300);
    let header = wal_header(&fixture);
    probe.set_prepay_hold(PREPAY_HOLD_AFTER_LOCK);
    probe.request_run();
    assert!(probe.wait_prepay_holding(PREPAY_HOLD_AFTER_LOCK, WAIT));
    let outcome = std::thread::scope(|scope| {
        let stopper = scope.spawn(|| db.stop_background_checkpoint());
        let deadline = std::time::Instant::now() + WAIT;
        while !probe.stop_requested() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(probe.stop_requested(), "the stop request must be raised");
        probe.set_prepay_hold(PREPAY_HOLD_NONE);
        stopper.join().expect("stopper")
    });
    assert_eq!(outcome, StopOutcome::Joined);
    let stats = db.background_checkpoint_stats().expect("stats");
    assert_eq!(
        (stats.prepay_restarted, stats.prepay_skipped, stats.failures),
        (0, 1, 0),
        "{stats:?}"
    );
    assert_eq!(wal_header(&fixture), header, "nothing was committed");
}

/// 停止の要求が、先払いの前（Mutex を取る前）に来たときは、入口の確認で飛ばして何も書かない
/// （取得の後の確認は、上の試験が別に固定する）。
#[test]
fn a_stop_that_arrives_before_the_prepay_takes_the_connection_skips_it() {
    let fixture = Fixture::new("prepay-stop");
    let db = fixture.open();
    let probe = started(&db);
    append_pages(&db, 300);
    let header = wal_header(&fixture);
    probe.set_prepay_hold(PREPAY_HOLD_BEFORE_LOCK);
    probe.request_run();
    assert!(probe.wait_prepay_holding(PREPAY_HOLD_BEFORE_LOCK, WAIT));
    let outcome = std::thread::scope(|scope| {
        let stopper = scope.spawn(|| db.stop_background_checkpoint());
        // 停止の要求が立ってから解放する（先払いが「停止の後」に取得を試みる状態を決定的にする）。
        let deadline = std::time::Instant::now() + WAIT;
        while !probe.stop_requested() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(probe.stop_requested(), "the stop request must be raised");
        probe.set_prepay_hold(PREPAY_HOLD_NONE);
        stopper.join().expect("stopper")
    });
    assert_eq!(outcome, StopOutcome::Joined);
    let stats = db.background_checkpoint_stats().expect("stats");
    assert_eq!(
        (stats.prepay_restarted, stats.prepay_skipped, stats.failures),
        (0, 1, 0),
        "{stats:?}"
    );
    assert_eq!(wal_header(&fixture), header, "nothing was committed");
}

/// `stop` が `TimedOut`（スレッドが `Weak` を upgrade したまま残る）でも、`Database` の drop は
/// 主接続を自分で閉じる：drop が戻った時点で `-wal` が畳まれて消えている。スレッドは
/// その後、停止の要求を見て何も書かずに終わる。
#[test]
fn drop_closes_the_main_connection_even_when_the_stop_times_out() {
    let fixture = Fixture::new("prepay-drop");
    let db = fixture.open();
    let probe = started(&db);
    probe.set_stop_wait(Duration::from_millis(150));
    append_pages(&db, 300);
    probe.set_prepay_hold(PREPAY_HOLD_BEFORE_LOCK);
    probe.request_run();
    assert!(probe.wait_prepay_holding(PREPAY_HOLD_BEFORE_LOCK, WAIT));
    assert!(fixture.wal_path().exists());

    drop(db);
    assert!(
        !probe.thread_exited(),
        "the thread is still alive with its upgraded handle"
    );
    assert!(
        !fixture.wal_path().exists(),
        "the main connection was closed by the drop itself (last connection: the WAL is removed)"
    );

    probe.set_prepay_hold(PREPAY_HOLD_NONE);
    let deadline = std::time::Instant::now() + WAIT;
    while !probe.thread_exited() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(probe.thread_exited());
    assert_eq!(
        probe.prepay_counts(),
        (0, 0, 1, 0),
        "after the drop the late prepay must not write"
    );
    let conn = rusqlite::Connection::open(&fixture.path).expect("reopen");
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("integrity");
    assert_eq!(integrity, "ok");
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM payload", [], |row| row.get(0))
        .expect("count");
    assert_eq!(rows, 300);
}

/// standalone MCP の `from_connection` は背景を始めず、core の型の変更で挙動は変わらない。
#[test]
fn an_adopted_connection_has_no_background_and_no_prepay() {
    let fixture = Fixture::new("adopted");
    drop(fixture.open());
    let conn = rusqlite::Connection::open(&fixture.path).expect("adopted connection");
    let db = Database::from_connection(conn);
    assert!(db.background_checkpoint_stats().is_none());
    assert!(db.background_checkpoint_probe().is_none());
    append_pages(&db, 20);
    assert_eq!(db.stop_background_checkpoint(), StopOutcome::AlreadyStopped);
    assert!(db.connection_reusable());
    drop(db);
}

/// checkpoint は write clock（lineage・seq）・schema・ReadIdentity を動かさない（DR-DBC-5）。
#[test]
fn checkpoint_does_not_move_the_write_clock_or_read_identity() {
    let fixture = Fixture::new("identity");
    let db = fixture.open();
    // payload 表を clock の対象にする（この fixture は migration を通らない ad-hoc の DB）。
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        crate::write_clock::install_write_clock_in_tx(conn)?;
        conn.execute_batch("COMMIT")?;
        Ok(())
    })
    .expect("install the write clock");
    let probe = started(&db);

    // 自分の大きい commit。背景の checkpoint は、この直後に別接続で走る。
    let runs = probe.stats_runs();
    append_pages(&db, 2 * WAL_CHECKPOINT_PAGES);
    let revision = db.with_conn(read_db_clock).expect("revision");
    let identity = db
        .with_conn(ReadIdentity::read_unpinned)
        .expect("identity")
        .expect("identity is observable");
    // 背景が走っている最中も、終わった後も、同じ identity が読める。
    let mut samples = 0;
    while probe.stats_runs() == runs || !probe.wait_idle(Duration::from_millis(1)) {
        assert_eq!(
            db.with_conn(read_db_clock).expect("revision sample"),
            revision
        );
        assert_eq!(
            db.with_conn(ReadIdentity::read_unpinned)
                .expect("identity sample")
                .as_ref(),
            Some(&identity)
        );
        samples += 1;
        assert!(samples < 100_000, "background checkpoint must finish");
    }
    assert!(
        probe.stats_runs() > runs,
        "a checkpoint ran after the commit"
    );
    assert_eq!(
        db.with_conn(read_db_clock).expect("revision after"),
        revision
    );
    assert_eq!(
        db.with_conn(ReadIdentity::read_unpinned)
            .expect("identity after")
            .as_ref(),
        Some(&identity)
    );

    // 別の接続が PASSIVE で checkpoint しても同じ。
    let other = rusqlite::Connection::open(&fixture.path).expect("other connection");
    sqlite_wal_checkpoint(&other, OpenWalCheckpointMode::Passive).expect("passive from other");
    drop(other);
    assert_eq!(
        db.with_conn(read_db_clock)
            .expect("revision after foreign checkpoint"),
        revision
    );

    // 読み手が snapshot を持つ間に背景が走っても、その snapshot の identity は変わらない。
    let pinned = db
        .with_conn(|conn| {
            conn.execute_batch("BEGIN")?;
            let first = ReadIdentity::read(conn)?;
            let before = probe.stats_runs();
            probe.request_run();
            anyhow::ensure!(probe.wait_runs_at_least(before + 1, WAIT), "run");
            let second = ReadIdentity::read(conn)?;
            conn.execute_batch("ROLLBACK")?;
            Ok((first, second))
        })
        .expect("pinned identities");
    assert!(pinned.0.is_some());
    assert_eq!(pinned.0, pinned.1);

    // 対照：別の接続の commit では seq が進む。この試験はそれを検出できる。
    let writer = rusqlite::Connection::open(&fixture.path).expect("writer connection");
    writer
        .execute("INSERT INTO payload (body) VALUES (zeroblob(10))", [])
        .expect("foreign commit");
    drop(writer);
    let moved = db
        .with_conn(read_db_clock)
        .expect("revision after foreign commit");
    assert_eq!(moved.lineage, revision.lineage);
    assert_eq!(moved.seq, revision.seq + 1);
}

/// 停止：実行中でなければ join でき、2 回目は何もしない。以後は同期の checkpoint に戻る
/// ので、上限は失われない。
#[test]
fn stop_is_idempotent_and_falls_back_to_a_synchronous_checkpoint() {
    let fixture = Fixture::new("stop");
    let db = fixture.open();
    let probe = started(&db);
    assert_eq!(db.stop_background_checkpoint(), StopOutcome::Joined);
    assert!(probe.thread_exited());
    assert_eq!(db.stop_background_checkpoint(), StopOutcome::AlreadyStopped);
    assert_eq!(
        db.background_checkpoint_stats().expect("stats").mode,
        BackgroundCheckpointMode::Stopped
    );
    assert_eq!(db.background_checkpoint_threshold(), None);

    append_pages(&db, 2 * WAL_CHECKPOINT_PAGES);
    let state = wal_state(&db);
    assert!(state.log_frames >= 2 * WAL_CHECKPOINT_PAGES);
    assert_eq!(
        state.checkpointed_frames, state.log_frames,
        "after stop the hook checkpoints synchronously, as SQLite's default does"
    );
    // 止めた後に start し直せる（recovery の後の再開）。
    assert_eq!(
        db.start_background_checkpoint().expect("restart"),
        BackgroundCheckpointStart::Started
    );
}

/// 失敗が続いたら背景をやめ、同期の checkpoint に戻る。本体は壊れない。
#[cfg(unix)]
#[test]
fn repeated_failures_fall_back_to_synchronous_checkpoints() {
    let fixture = Fixture::new("failure");
    let db = fixture.open();
    let probe = started(&db);
    // checkpoint 専用の接続が開けなくなる（本体の接続は fd を持ったまま動く）。
    let moved = fixture.dir.join("moved-away.db");
    std::fs::rename(&fixture.path, &moved).expect("move db away from its path");

    let mut attempts = 0;
    while db.background_checkpoint_stats().expect("stats").mode == BackgroundCheckpointMode::Running
    {
        attempts += 1;
        assert!(
            attempts < 200,
            "background must give up after repeated failures"
        );
        append_pages(&db, WAL_CHECKPOINT_PAGES + 10);
        std::thread::sleep(Duration::from_millis(150));
    }
    let stats = db.background_checkpoint_stats().expect("stats");
    assert_eq!(stats.mode, BackgroundCheckpointMode::Failed);
    assert!(stats.failures >= 3);
    assert!(probe.thread_exited());
    assert_eq!(db.background_checkpoint_threshold(), None);

    append_pages(&db, 2 * WAL_CHECKPOINT_PAGES);
    let state = wal_state(&db);
    assert_eq!(
        state.checkpointed_frames, state.log_frames,
        "the foreground connection is still bounded by a synchronous checkpoint"
    );
    // 本体は使い続けられる。
    append_pages(&db, 10);
}

/// drop は、本体の接続を閉じる前に背景を止める。checkpoint 専用の接続が残らないので、
/// 最後の接続の close が WAL を畳んで消す。
#[test]
fn drop_stops_the_thread_and_leaves_no_second_connection() {
    let fixture = Fixture::new("drop");
    let db = fixture.open();
    let probe = started(&db);
    append_pages(&db, 2 * WAL_CHECKPOINT_PAGES);
    assert!(probe.wait_idle(WAIT));
    assert!(fixture.wal_path().exists());
    let started_at = std::time::Instant::now();
    drop(db);
    assert!(probe.thread_exited());
    assert!(started_at.elapsed() < super::background_checkpoint::STOP_WAIT);
    assert!(
        !fixture.wal_path().exists(),
        "the last connection must close cleanly and remove the WAL"
    );
}

/// close との競合：大きい commit の直後に閉じても、file は壊れず、上限の中で終わる。
#[test]
fn closing_right_after_a_large_commit_is_bounded_and_keeps_the_file_intact() {
    let fixture = Fixture::new("close-race");
    let mut expected_rows = 0_i64;
    for round in 0..15 {
        let db = fixture.open();
        let probe = started(&db);
        append_pages(&db, WAL_CHECKPOINT_PAGES + 50 + round);
        expected_rows += WAL_CHECKPOINT_PAGES + 50 + round;
        let begin = std::time::Instant::now();
        drop(db);
        assert!(
            begin.elapsed() < super::background_checkpoint::STOP_WAIT,
            "close must not wait for a running checkpoint beyond the bound"
        );
        assert!(probe.thread_exited());
    }
    let conn = rusqlite::Connection::open(&fixture.path).expect("reopen");
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("integrity");
    assert_eq!(integrity, "ok");
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM payload", [], |row| row.get(0))
        .expect("count");
    assert_eq!(rows, expected_rows);
}

/// backup（VACUUM INTO）は、背景の checkpoint が走る中でも一貫した複製を作る。
#[test]
fn backup_while_the_background_checkpoint_runs_is_consistent() {
    let fixture = Fixture::new("backup");
    let db = fixture.open();
    // backup_to は完全な schema（slim の対象表）を前提にする。
    db.migrate().expect("migrate backup fixture");
    let db = std::sync::Arc::new(db);
    let probe = started(&db);
    append_pages(&db, WAL_CHECKPOINT_PAGES + 100);
    let writer = {
        let db = std::sync::Arc::clone(&db);
        std::thread::spawn(move || {
            for _ in 0..20 {
                append_pages(&db, 120);
            }
        })
    };
    let mut backups = Vec::new();
    for index in 0..3 {
        let target = fixture.dir.join(format!("backup-{index}.db"));
        db.backup_to(&target).expect("backup");
        backups.push(target);
    }
    writer.join().expect("writer thread");
    assert!(probe.wait_idle(WAIT));
    for backup in backups {
        let conn = rusqlite::Connection::open(&backup).expect("open backup");
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("integrity");
        assert_eq!(integrity, "ok");
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM payload", [], |row| row.get(0))
            .expect("count");
        assert!(rows >= WAL_CHECKPOINT_PAGES + 100);
    }
}

/// recovery の retire は、背景を止めてから接続を取り替える。
#[test]
fn retiring_the_connection_for_recovery_stops_the_background_checkpoint() {
    let fixture = Fixture::new("retire");
    let db = fixture.open();
    let probe = started(&db);
    db.retire_connection_for_recovery().expect("retire");
    assert!(probe.thread_exited());
    assert_eq!(db.background_checkpoint_threshold(), None);
}

/// open の WAL 準備の上限は、pragma が 0 でも背景の閾値を単位にする。背景も無いなら今までどおり拒否する。
#[test]
fn open_wal_preparation_uses_the_background_threshold_as_its_cycle() {
    let fixture = Fixture::new("open-wal");
    let db = fixture.open();
    let _probe = started(&db);
    assert_eq!(pragma_autocheckpoint(&db), 0);
    // 閾値の 3/4 以上・閾値以下：RESTART で畳む対象の範囲。
    append_pages(&db, WAL_CHECKPOINT_PAGES * 4 / 5);
    let before = wal_state(&db);
    assert!(
        (750..=WAL_CHECKPOINT_PAGES).contains(&before.log_frames),
        "fixture must sit inside the preparation window: {before:?}"
    );
    let outcome = super::open_wal::prepare_wal_for_open(&db).expect("prepare with background");
    match outcome {
        OpenWalPreparationOutcome::Reset {
            auto_checkpoint, ..
        } => assert_eq!(auto_checkpoint, WAL_CHECKPOINT_PAGES),
        other => panic!("expected the window to be reset, got {other:?}"),
    }
    assert_eq!(
        pragma_autocheckpoint(&db),
        0,
        "preparation leaves the hook alone"
    );

    // 背景を止めた後（hook は同期の checkpoint）。pragma は 0 のまま、背景の閾値も無い。
    db.stop_background_checkpoint();
    let error = super::open_wal::prepare_wal_for_open(&db)
        .expect_err("no bound at all must still fail the open invariant");
    assert!(error
        .to_string()
        .contains("OPEN_WAL_AUTOCHECKPOINT_MUST_BE_POSITIVE"));
}

/// 専用の接続を開き、interrupt の handle を登録した後（run の最中）に止める。注入点で、
/// その状態にいることを観測してから止め、上限の中に終了の証拠が取れ、file が壊れない。
#[test]
fn stopping_while_a_run_holds_its_connection_open_joins_within_the_bound() {
    let fixture = Fixture::new("stop-holding");
    let db = fixture.open();
    let probe = started(&db);
    probe.set_hold_after_open(true);
    // 閾値以上・上限未満：背景へ知らせるだけで、hook は同期の checkpoint をしない。
    append_pages(&db, 2 * WAL_CHECKPOINT_PAGES);
    assert!(
        probe.wait_holding(WAIT),
        "the run must be inside its dedicated connection before the stop"
    );
    let release = {
        let probe = probe.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            probe.set_hold_after_open(false);
        })
    };
    let begin = std::time::Instant::now();
    assert_eq!(db.stop_background_checkpoint(), StopOutcome::Joined);
    assert!(begin.elapsed() < super::background_checkpoint::STOP_WAIT);
    release.join().expect("release thread");
    assert!(probe.thread_exited());
    append_pages(&db, 10);
    let integrity: String = db
        .with_conn(|conn| Ok(conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?))
        .expect("integrity");
    assert_eq!(integrity, "ok");
}

/// 上限未満の大きい WAL（実際の checkpoint）の直後に止める（実行中かどうかは問わない）。
#[test]
fn stopping_right_after_a_large_sub_limit_commit_joins_within_the_bound() {
    let fixture = Fixture::new("stop-large");
    for round in 0..3 {
        let db = fixture.open();
        let probe = started(&db);
        append_pages(&db, MAX_WAL_PAGES_BEFORE_SYNC - 500);
        let begin = std::time::Instant::now();
        assert_eq!(db.stop_background_checkpoint(), StopOutcome::Joined);
        assert!(begin.elapsed() < super::background_checkpoint::STOP_WAIT);
        assert!(probe.thread_exited());
        append_pages(&db, 10 + round);
        let integrity: String = db
            .with_conn(|conn| Ok(conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?))
            .expect("integrity");
        assert_eq!(integrity, "ok");
    }
}

/// 注入：run が止まらない。TimedOut を返し、スレッドは残り、次の stop が同じスレッドを待てる。
#[test]
fn a_stop_that_times_out_keeps_the_thread_and_a_later_stop_waits_for_it_again() {
    let fixture = Fixture::new("timed-out");
    let db = fixture.open();
    let probe = started(&db);
    probe.set_stall(true);
    probe.set_stop_wait(Duration::from_millis(150));
    probe.request_run();
    assert!(probe.wait_running(WAIT));

    assert_eq!(db.stop_background_checkpoint(), StopOutcome::TimedOut);
    assert!(!probe.thread_exited(), "no termination evidence yet");
    // もう一度止めても AlreadyStopped にならない（終了の証拠が無いので）。
    assert_eq!(db.stop_background_checkpoint(), StopOutcome::TimedOut);

    probe.set_stall(false);
    probe.set_stop_wait(Duration::from_secs(10));
    assert_eq!(db.stop_background_checkpoint(), StopOutcome::Joined);
    assert!(probe.thread_exited());
    assert_eq!(db.stop_background_checkpoint(), StopOutcome::AlreadyStopped);
    assert_eq!(
        db.background_checkpoint_stats().expect("stats").failures,
        0,
        "a stopped run is not a failure"
    );
}

/// recovery の retire は、背景が止まらないなら何も変えずに失敗する（fail-closed）。
#[test]
fn retire_fails_closed_while_the_background_checkpoint_does_not_stop() {
    let fixture = Fixture::new("retire-timeout");
    let db = fixture.open();
    let probe = started(&db);
    probe.set_stall(true);
    probe.set_stop_wait(Duration::from_millis(150));
    probe.request_run();
    assert!(probe.wait_running(WAIT));

    let error = db
        .retire_connection_for_recovery()
        .expect_err("retire must fail while the checkpoint thread is alive");
    assert!(error
        .to_string()
        .contains("RETIREMENT_BACKGROUND_CHECKPOINT_STOP_TIMEOUT"));
    assert!(db.connection_reusable(), "nothing was retired");
    assert!(!db.retirement_close_pending());
    append_pages(&db, 10);

    probe.set_stall(false);
    probe.set_stop_wait(Duration::from_secs(10));
    db.retire_connection_for_recovery()
        .expect("retire succeeds once the thread has ended");
    assert!(probe.thread_exited());
}

/// 背景が追いつかない（止まっている）間も、書き手が連続しても WAL は上限で止まる。
#[test]
fn a_stalled_background_checkpoint_cannot_let_the_wal_grow_without_bound() {
    let fixture = Fixture::new("stalled-burst");
    let db = fixture.open();
    let probe = started(&db);
    probe.set_stall(true);
    probe.set_sync_wait(Duration::from_millis(200));
    let mut max_frames = 0;
    for _ in 0..100 {
        append_pages(&db, 150);
        max_frames = max_frames.max(wal_state(&db).log_frames);
    }
    probe.set_stall(false);
    // 150 page × 100 回 ＝ 15000 page。同期の checkpoint が上限（4000）で畳む。
    assert!(
        max_frames <= MAX_WAL_PAGES_BEFORE_SYNC + 2 * 150,
        "WAL must stop at the hard limit, saw {max_frames} frames"
    );
    assert!(
        max_frames >= WAL_CHECKPOINT_PAGES,
        "the burst did exceed the soft threshold"
    );
    assert_eq!(MAX_WAL_PAGES_BEFORE_SYNC, 4 * WAL_CHECKPOINT_PAGES);
}

/// wait_idle を挟まない連続の書き手（実際の背景が動く）。
#[test]
fn a_continuous_writer_keeps_the_wal_under_the_hard_limit() {
    let fixture = Fixture::new("continuous");
    let db = fixture.open();
    let _probe = started(&db);
    let mut max_frames = 0;
    for _ in 0..100 {
        append_pages(&db, 150);
        max_frames = max_frames.max(wal_state(&db).log_frames);
    }
    let stats = db.background_checkpoint_stats().expect("stats");
    assert!(
        max_frames <= MAX_WAL_PAGES_BEFORE_SYNC + 2 * 150,
        "WAL must stay under the hard limit, saw {max_frames} frames; stats {stats:?}"
    );
}

/// open の WAL 準備は、wal hook が背景のものであると確かめられたときだけ背景の閾値を単位にする。
#[test]
fn open_wal_preparation_checks_that_the_hook_still_belongs_to_the_background() {
    let fixture = Fixture::new("hook-check");
    let db = fixture.open();
    let _probe = started(&db);
    assert_eq!(
        db.with_conn(|conn| Ok(db.background_checkpoint_bound(conn)))
            .expect("bound"),
        Some(WAL_CHECKPOINT_PAGES)
    );

    // hook が外される（pragma 0 は hook を消す）と、背景の上限は効いていない。
    db.with_conn(|conn| {
        conn.pragma_update(None, "wal_autocheckpoint", 0)?;
        Ok(())
    })
    .expect("clear hook");
    assert_eq!(
        db.with_conn(|conn| Ok(db.background_checkpoint_bound(conn)))
            .expect("bound after replace"),
        None
    );
    // 入れ直しの後は pragma が 0 で背景も確かめられないので、今までどおり拒否する。
    db.with_conn(|conn| {
        conn.pragma_update(None, "wal_autocheckpoint", 0)?;
        Ok(())
    })
    .expect("clear hook again");
    let error = super::open_wal::prepare_wal_for_open(&db)
        .expect_err("a replaced hook must not be accepted as a bound");
    assert!(error
        .to_string()
        .contains("OPEN_WAL_AUTOCHECKPOINT_MUST_BE_POSITIVE"));
}

/// 止まった背景の run には、上限を超えた commit が一度しか待たない（本体の Mutex を握ったまま
/// 毎回 5 s 待たない）。時間ではなく、待ちを諦めた回数で確かめる（遅い disk でも揺れない）。
#[test]
fn an_over_limit_commit_waits_for_a_stuck_run_only_once() {
    let fixture = Fixture::new("wait-once");
    let db = fixture.open();
    let probe = started(&db);
    probe.set_stall(true);
    probe.set_sync_wait(Duration::from_millis(200));
    probe.request_run();
    assert!(probe.wait_running(WAIT));

    // 150 page × 120 回。上限（4000 page）を何度も超える。
    for _ in 0..120 {
        append_pages(&db, 150);
    }
    let stats = db.background_checkpoint_stats().expect("stats");
    assert!(
        stats.sync_fallbacks >= 3,
        "the burst must have crossed the hard limit several times: {stats:?}"
    );
    assert_eq!(
        stats.sync_wait_timeouts, 1,
        "only the first over-limit commit waits for the stuck run: {stats:?}"
    );
    probe.set_stall(false);
}
