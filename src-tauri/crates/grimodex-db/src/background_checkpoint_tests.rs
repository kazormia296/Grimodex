//! DR-DBC-1: 背景の WAL checkpoint の lifecycle・上限・識別の試験。

use super::background_checkpoint::{
    BackgroundCheckpointMode, BackgroundCheckpointProbe, BackgroundCheckpointStart, StopOutcome,
    MAX_WAL_PAGES_BEFORE_SYNC, WAL_CHECKPOINT_PAGES,
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

/// 大きい commit の書戻しは、背景の接続（別 thread）が PASSIVE で行う。
#[test]
fn a_large_commit_is_written_back_by_the_background_connection() {
    let fixture = Fixture::new("not-inline");
    let db = fixture.open();
    let probe = started(&db);
    let before = probe.stats_runs();
    append_pages(&db, 3 * WAL_CHECKPOINT_PAGES);
    assert!(probe.wait_runs_at_least(before + 1, WAIT));
    assert!(probe.wait_idle(WAIT));
    let state = wal_state(&db);
    assert!(state.log_frames >= 3 * WAL_CHECKPOINT_PAGES);
    assert_eq!(
        state.checkpointed_frames, state.log_frames,
        "PASSIVE from the background connection wrote the WAL back"
    );
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
