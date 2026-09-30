use crate::Database;
use rusqlite::{Connection, Error as SqliteError};
use std::time::Duration;

const OPEN_WAL_BUSY_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenWalCheckpointMode {
    Noop,
    #[cfg(test)]
    Passive,
    Restart,
}

impl OpenWalCheckpointMode {
    fn sql(self) -> &'static str {
        match self {
            Self::Noop => "PRAGMA main.wal_checkpoint(NOOP)",
            #[cfg(test)]
            Self::Passive => "PRAGMA main.wal_checkpoint(PASSIVE)",
            Self::Restart => "PRAGMA main.wal_checkpoint(RESTART)",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct WalCheckpointState {
    pub(crate) busy: i64,
    pub(crate) log_frames: i64,
    pub(crate) checkpointed_frames: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenWalNoopReason {
    NotWal,
    BelowThreshold,
    InspectionUnavailable,
    CheckpointUnavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenWalErrorCode {
    CheckpointQuery,
}

/// Internal, path-free evidence for the bounded WAL preparation performed
/// before a workspace authority is published.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenWalPreparationOutcome {
    Noop {
        reason: OpenWalNoopReason,
        auto_checkpoint: i64,
        log_frames: Option<i64>,
        checkpointed_frames: Option<i64>,
        error_code: Option<OpenWalErrorCode>,
    },
    Reset {
        auto_checkpoint: i64,
        busy: i64,
        log_frames: i64,
        checkpointed_frames: i64,
    },
    Deferred {
        auto_checkpoint: i64,
        busy: i64,
        log_frames: i64,
        checkpointed_frames: i64,
    },
    DeferredWorkLimit {
        auto_checkpoint: i64,
        busy: i64,
        log_frames: i64,
        checkpointed_frames: i64,
    },
    DeferredContention {
        auto_checkpoint: i64,
        busy: i64,
        log_frames: i64,
        checkpointed_frames: i64,
    },
}

pub(crate) fn sqlite_wal_checkpoint(
    conn: &Connection,
    mode: OpenWalCheckpointMode,
) -> Result<WalCheckpointState, SqliteError> {
    conn.query_row(mode.sql(), [], |row| {
        Ok(WalCheckpointState {
            busy: row.get(0)?,
            log_frames: row.get(1)?,
            checkpointed_frames: row.get(2)?,
        })
    })
}

pub(crate) fn sqlite_set_busy_timeout(
    conn: &Connection,
    timeout: Duration,
) -> Result<(), SqliteError> {
    conn.busy_timeout(timeout)
}

fn query_i64_pragma(conn: &Connection, name: &str) -> anyhow::Result<i64> {
    Ok(conn.pragma_query_value(None, name, |row| row.get(0))?)
}

fn noop(
    reason: OpenWalNoopReason,
    auto_checkpoint: i64,
    state: Option<WalCheckpointState>,
    error_code: Option<OpenWalErrorCode>,
) -> OpenWalPreparationOutcome {
    OpenWalPreparationOutcome::Noop {
        reason,
        auto_checkpoint,
        log_frames: state.map(|value| value.log_frames),
        checkpointed_frames: state.map(|value| value.checkpointed_frames),
        error_code,
    }
}

fn validate_checkpoint_state(state: WalCheckpointState) -> anyhow::Result<()> {
    let no_wal = state.log_frames == -1 && state.checkpointed_frames == -1;
    let wal = state.log_frames >= 0
        && state.checkpointed_frames >= 0
        && state.checkpointed_frames <= state.log_frames;
    anyhow::ensure!(
        (no_wal || wal) && (state.busy == 0 || state.busy == 1),
        "OPEN_WAL_CHECKPOINT_STATE_INVALID"
    );
    Ok(())
}

fn verify_connection_settings(
    conn: &Connection,
    original_timeout_ms: i64,
    auto_checkpoint: i64,
) -> anyhow::Result<()> {
    let restored_timeout_ms = query_i64_pragma(conn, "busy_timeout")
        .map_err(|_| anyhow::anyhow!("OPEN_WAL_TIMEOUT_RESTORE_FAILED"))?;
    anyhow::ensure!(
        restored_timeout_ms == original_timeout_ms,
        "OPEN_WAL_TIMEOUT_RESTORE_FAILED"
    );
    let auto_after = query_i64_pragma(conn, "wal_autocheckpoint")?;
    anyhow::ensure!(
        auto_after == auto_checkpoint,
        "OPEN_WAL_AUTOCHECKPOINT_CHANGED"
    );
    Ok(())
}

fn prepare_wal_for_open_on_connection_with<C, S>(
    conn: &Connection,
    checkpoint: &mut C,
    set_busy_timeout: &mut S,
) -> anyhow::Result<OpenWalPreparationOutcome>
where
    C: FnMut(&Connection, OpenWalCheckpointMode) -> Result<WalCheckpointState, SqliteError>,
    S: FnMut(&Connection, Duration) -> Result<(), SqliteError>,
{
    anyhow::ensure!(conn.is_autocommit(), "OPEN_WAL_ACTIVE_TRANSACTION");
    let auto_checkpoint = query_i64_pragma(conn, "wal_autocheckpoint")?;
    anyhow::ensure!(
        auto_checkpoint > 0,
        "OPEN_WAL_AUTOCHECKPOINT_MUST_BE_POSITIVE"
    );

    let before = match checkpoint(conn, OpenWalCheckpointMode::Noop) {
        Ok(state) => state,
        Err(_) => {
            // Inspection is an open-time performance optimization. A failed
            // read-only probe has not changed the connection, so preserve
            // workspace availability and expose only a fixed internal code.
            return Ok(noop(
                OpenWalNoopReason::InspectionUnavailable,
                auto_checkpoint,
                None,
                Some(OpenWalErrorCode::CheckpointQuery),
            ));
        }
    };
    validate_checkpoint_state(before)?;
    if before.log_frames == -1 {
        return match before.busy {
            0 => Ok(noop(
                OpenWalNoopReason::NotWal,
                auto_checkpoint,
                Some(before),
                None,
            )),
            1 => Ok(OpenWalPreparationOutcome::DeferredContention {
                auto_checkpoint,
                busy: before.busy,
                log_frames: before.log_frames,
                checkpointed_frames: before.checkpointed_frames,
            }),
            _ => Err(anyhow::anyhow!("OPEN_WAL_CHECKPOINT_STATE_INVALID")),
        };
    }

    let threshold = auto_checkpoint
        .checked_mul(3)
        .and_then(|value| value.checked_add(3))
        .map(|value| value / 4)
        .ok_or_else(|| anyhow::anyhow!("OPEN_WAL_THRESHOLD_OVERFLOW"))?;
    if before.log_frames < threshold {
        return Ok(noop(
            OpenWalNoopReason::BelowThreshold,
            auto_checkpoint,
            Some(before),
            None,
        ));
    }
    if before.log_frames > auto_checkpoint {
        // busy_timeout bounds lock acquisition only; it is not a wall-clock
        // bound for synchronous checkpoint I/O. Restrict open-time RESTART
        // work to at most one configured autocheckpoint cycle. This still is
        // not a hard time guarantee, so the canonical performance budget must
        // remain the acceptance authority.
        return Ok(OpenWalPreparationOutcome::DeferredWorkLimit {
            auto_checkpoint,
            busy: before.busy,
            log_frames: before.log_frames,
            checkpointed_frames: before.checkpointed_frames,
        });
    }

    let original_timeout_ms = query_i64_pragma(conn, "busy_timeout")?;
    anyhow::ensure!(original_timeout_ms >= 0, "OPEN_WAL_BUSY_TIMEOUT_INVALID");
    set_busy_timeout(conn, OPEN_WAL_BUSY_TIMEOUT)?;
    let checkpoint_result = checkpoint(conn, OpenWalCheckpointMode::Restart);
    let restore_result = set_busy_timeout(
        conn,
        Duration::from_millis(
            u64::try_from(original_timeout_ms)
                .map_err(|_| anyhow::anyhow!("OPEN_WAL_BUSY_TIMEOUT_INVALID"))?,
        ),
    );
    if restore_result.is_err() {
        return Err(anyhow::anyhow!("OPEN_WAL_TIMEOUT_RESTORE_FAILED"));
    }
    verify_connection_settings(conn, original_timeout_ms, auto_checkpoint)?;

    let restarted = match checkpoint_result {
        Ok(state) => state,
        Err(_) => {
            // The timeout and autocheckpoint settings were restored and
            // verified above. Keep open fail-soft for a checkpoint engine
            // error; restoration failure is the fail-closed boundary.
            return Ok(noop(
                OpenWalNoopReason::CheckpointUnavailable,
                auto_checkpoint,
                Some(before),
                Some(OpenWalErrorCode::CheckpointQuery),
            ));
        }
    };
    validate_checkpoint_state(restarted)?;
    match restarted.busy {
        0 => Ok(OpenWalPreparationOutcome::Reset {
            auto_checkpoint,
            busy: restarted.busy,
            log_frames: restarted.log_frames,
            checkpointed_frames: restarted.checkpointed_frames,
        }),
        1 => Ok(OpenWalPreparationOutcome::Deferred {
            auto_checkpoint,
            busy: restarted.busy,
            log_frames: restarted.log_frames,
            checkpointed_frames: restarted.checkpointed_frames,
        }),
        _ => Err(anyhow::anyhow!("OPEN_WAL_CHECKPOINT_STATE_INVALID")),
    }
}

pub(crate) fn prepare_wal_for_open(
    database: &Database,
) -> anyhow::Result<OpenWalPreparationOutcome> {
    database.with_conn(|conn| {
        let mut checkpoint = sqlite_wal_checkpoint;
        let mut set_busy_timeout = sqlite_set_busy_timeout;
        prepare_wal_for_open_on_connection_with(conn, &mut checkpoint, &mut set_busy_timeout)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use rusqlite::{Connection, Error as SqliteError};
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    struct WalFixture {
        dir: PathBuf,
        path: PathBuf,
        database: Database,
    }

    impl WalFixture {
        fn new(auto_checkpoint: i64) -> Self {
            let dir =
                std::env::temp_dir().join(format!("grimodex-open-wal-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create WAL fixture directory");
            let path = dir.join("grimodex.db");
            let conn = Connection::open(&path).expect("open WAL fixture");
            conn.execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB NOT NULL);",
            )
            .expect("create WAL fixture schema");
            conn.pragma_update(None, "wal_autocheckpoint", auto_checkpoint)
                .expect("configure fixture autocheckpoint");
            let database = Database::from_connection(conn);
            let fixture = Self {
                dir,
                path,
                database,
            };
            fixture.restart_checkpoint();
            fixture
        }

        fn append_pages(&self, rows: i64) {
            self.database
                .with_conn(|conn| {
                    conn.execute(
                        "WITH RECURSIVE seq(n) AS (
                             SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?1
                         )
                         INSERT INTO payload (body)
                         SELECT zeroblob(4096) FROM seq",
                        [rows],
                    )?;
                    Ok(())
                })
                .expect("append WAL pages");
        }

        fn checkpoint(&self, mode: OpenWalCheckpointMode) -> WalCheckpointState {
            self.database
                .with_conn(|conn| sqlite_wal_checkpoint(conn, mode).map_err(Into::into))
                .expect("query WAL checkpoint state")
        }

        fn restart_checkpoint(&self) {
            let state = self.checkpoint(OpenWalCheckpointMode::Restart);
            assert_eq!(state.busy, 0, "fixture RESTART checkpoint must succeed");
        }

        fn busy_timeout_ms(&self) -> i64 {
            self.database
                .with_conn(|conn| {
                    Ok(conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))?)
                })
                .expect("query busy timeout")
        }

        fn auto_checkpoint(&self) -> i64 {
            self.database
                .with_conn(|conn| {
                    Ok(conn.pragma_query_value(None, "wal_autocheckpoint", |row| row.get(0))?)
                })
                .expect("query autocheckpoint")
        }

        fn set_auto_checkpoint(&self, value: i64) {
            self.database
                .with_conn(|conn| {
                    conn.pragma_update(None, "wal_autocheckpoint", value)?;
                    Ok(())
                })
                .expect("set autocheckpoint");
        }
    }

    impl Drop for WalFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn below_threshold_and_non_wal_connections_are_noops() {
        let fixture = WalFixture::new(1_000);
        fixture.append_pages(1);
        let outcome = prepare_wal_for_open(&fixture.database).expect("prepare below threshold");
        assert!(matches!(
            outcome,
            OpenWalPreparationOutcome::Noop {
                reason: OpenWalNoopReason::BelowThreshold,
                ..
            }
        ));
        assert_eq!(fixture.auto_checkpoint(), 1_000);

        let conn = Connection::open_in_memory().expect("open non-WAL database");
        conn.pragma_update(None, "wal_autocheckpoint", 1_000)
            .expect("configure non-WAL autocheckpoint");
        let database = Database::from_connection(conn);
        let outcome = prepare_wal_for_open(&database).expect("prepare non-WAL database");
        assert!(matches!(
            outcome,
            OpenWalPreparationOutcome::Noop {
                reason: OpenWalNoopReason::NotWal,
                ..
            }
        ));
    }

    #[test]
    fn oversized_wal_is_deferred_without_checkpoint_or_timeout_mutation() {
        let fixture = WalFixture::new(1_000);
        fixture
            .database
            .with_conn(|conn| {
                conn.busy_timeout(Duration::from_millis(4_321))?;
                let mut checkpoint_modes = Vec::new();
                let mut checkpoint = |_conn: &Connection, mode: OpenWalCheckpointMode| {
                    checkpoint_modes.push(mode);
                    Ok(WalCheckpointState {
                        busy: 0,
                        log_frames: 1_001,
                        checkpointed_frames: 1_000,
                    })
                };
                let mut timeout_calls = 0;
                let mut set_timeout = |_conn: &Connection, _timeout: Duration| {
                    timeout_calls += 1;
                    Ok(())
                };

                let outcome = prepare_wal_for_open_on_connection_with(
                    conn,
                    &mut checkpoint,
                    &mut set_timeout,
                )?;

                assert_eq!(
                    outcome,
                    OpenWalPreparationOutcome::DeferredWorkLimit {
                        auto_checkpoint: 1_000,
                        busy: 0,
                        log_frames: 1_001,
                        checkpointed_frames: 1_000,
                    }
                );
                assert_eq!(
                    format!("{outcome:?}"),
                    "DeferredWorkLimit { auto_checkpoint: 1000, busy: 0, log_frames: 1001, checkpointed_frames: 1000 }"
                );
                assert_eq!(checkpoint_modes, vec![OpenWalCheckpointMode::Noop]);
                assert_eq!(timeout_calls, 0);
                Ok(())
            })
            .expect("defer oversized WAL");
        assert_eq!(fixture.busy_timeout_ms(), 4_321);
        assert_eq!(fixture.auto_checkpoint(), 1_000);
    }

    #[test]
    fn unavailable_tuple_with_busy_is_contention_not_not_wal() {
        let fixture = WalFixture::new(1_000);
        fixture
            .database
            .with_conn(|conn| {
                conn.busy_timeout(Duration::from_millis(3_210))?;
                let mut checkpoint_modes = Vec::new();
                let mut checkpoint = |_conn: &Connection, mode: OpenWalCheckpointMode| {
                    checkpoint_modes.push(mode);
                    Ok(WalCheckpointState {
                        busy: 1,
                        log_frames: -1,
                        checkpointed_frames: -1,
                    })
                };
                let mut timeout_calls = 0;
                let mut set_timeout = |_conn: &Connection, _timeout: Duration| {
                    timeout_calls += 1;
                    Ok(())
                };

                let outcome = prepare_wal_for_open_on_connection_with(
                    conn,
                    &mut checkpoint,
                    &mut set_timeout,
                )?;

                assert_eq!(
                    outcome,
                    OpenWalPreparationOutcome::DeferredContention {
                        auto_checkpoint: 1_000,
                        busy: 1,
                        log_frames: -1,
                        checkpointed_frames: -1,
                    }
                );
                assert_eq!(
                    format!("{outcome:?}"),
                    "DeferredContention { auto_checkpoint: 1000, busy: 1, log_frames: -1, checkpointed_frames: -1 }"
                );
                assert_eq!(checkpoint_modes, vec![OpenWalCheckpointMode::Noop]);
                assert_eq!(timeout_calls, 0);
                Ok(())
            })
            .expect("preserve unavailable contention tuple");
        assert_eq!(fixture.busy_timeout_ms(), 3_210);
        assert_eq!(fixture.auto_checkpoint(), 1_000);
    }

    #[test]
    fn total_backfilled_frames_at_threshold_still_trigger_restart() {
        let fixture = WalFixture::new(1_000);
        fixture.append_pages(16);
        let passive = fixture.checkpoint(OpenWalCheckpointMode::Passive);
        assert_eq!(passive.busy, 0);
        assert!(passive.log_frames > 0);
        assert_eq!(passive.log_frames, passive.checkpointed_frames);
        fixture.set_auto_checkpoint(passive.log_frames);

        let outcome = prepare_wal_for_open(&fixture.database).expect("prepare backfilled WAL");
        assert!(matches!(
            outcome,
            OpenWalPreparationOutcome::Reset {
                auto_checkpoint,
                busy: 0,
                ..
            } if auto_checkpoint == passive.log_frames
        ));
        assert_eq!(fixture.auto_checkpoint(), passive.log_frames);

        fixture.append_pages(1);
        let next_writer = fixture.checkpoint(OpenWalCheckpointMode::Noop);
        let threshold = (passive.log_frames * 3 + 3) / 4;
        assert!(
            next_writer.log_frames < threshold,
            "RESTART must make the next writer begin below the threshold"
        );
    }

    #[test]
    fn held_reader_defers_within_bound_and_restores_timeout_then_retry_resets() {
        let fixture = WalFixture::new(1_000);
        fixture
            .database
            .with_conn(|conn| {
                conn.busy_timeout(Duration::from_millis(4_321))?;
                Ok(())
            })
            .expect("set original timeout");
        let reader = Connection::open(&fixture.path).expect("open held reader");
        reader.execute_batch("BEGIN").expect("begin held read");
        let _: i64 = reader
            .query_row("SELECT count(*) FROM payload", [], |row| row.get(0))
            .expect("establish held read snapshot");
        fixture.append_pages(16);
        let before = fixture.checkpoint(OpenWalCheckpointMode::Noop);
        fixture.set_auto_checkpoint(before.log_frames);

        let started = Instant::now();
        let outcome = prepare_wal_for_open(&fixture.database).expect("defer held-reader reset");
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(matches!(
            outcome,
            OpenWalPreparationOutcome::Deferred { busy: 1, .. }
        ));
        assert_eq!(fixture.busy_timeout_ms(), 4_321);
        assert_eq!(fixture.auto_checkpoint(), before.log_frames);

        reader.execute_batch("COMMIT").expect("release held reader");
        let retry = prepare_wal_for_open(&fixture.database).expect("retry reset");
        assert!(matches!(retry, OpenWalPreparationOutcome::Reset { .. }));
        assert_eq!(fixture.busy_timeout_ms(), 4_321);
    }

    #[test]
    fn noop_query_error_is_fail_soft_without_connection_mutation() {
        let fixture = WalFixture::new(8);
        fixture
            .database
            .with_conn(|conn| {
                conn.busy_timeout(Duration::from_millis(3_210))?;
                let mut checkpoint = |_conn: &Connection, _mode: OpenWalCheckpointMode| {
                    Err(SqliteError::InvalidQuery)
                };
                let mut set_timeout = sqlite_set_busy_timeout;
                let outcome = prepare_wal_for_open_on_connection_with(
                    conn,
                    &mut checkpoint,
                    &mut set_timeout,
                )?;
                assert!(matches!(
                    outcome,
                    OpenWalPreparationOutcome::Noop {
                        reason: OpenWalNoopReason::InspectionUnavailable,
                        ..
                    }
                ));
                Ok(())
            })
            .expect("fail-soft NOOP inspection");
        assert_eq!(fixture.busy_timeout_ms(), 3_210);
        assert_eq!(fixture.auto_checkpoint(), 8);
    }

    #[test]
    fn timeout_restore_failure_is_terminal_and_visible() {
        let fixture = WalFixture::new(1_000);
        fixture.append_pages(16);
        let before = fixture.checkpoint(OpenWalCheckpointMode::Noop);
        fixture.set_auto_checkpoint(before.log_frames);
        let error = fixture
            .database
            .with_conn(|conn| {
                let mut checkpoint = sqlite_wal_checkpoint;
                let mut calls = 0;
                let mut set_timeout = |conn: &Connection, timeout: Duration| {
                    calls += 1;
                    if calls == 2 {
                        return Err(SqliteError::InvalidQuery);
                    }
                    sqlite_set_busy_timeout(conn, timeout)
                };
                prepare_wal_for_open_on_connection_with(conn, &mut checkpoint, &mut set_timeout)
            })
            .expect_err("timeout restoration must fail closed");
        assert!(error
            .to_string()
            .contains("OPEN_WAL_TIMEOUT_RESTORE_FAILED"));
        assert_eq!(fixture.auto_checkpoint(), before.log_frames);
    }

    #[test]
    fn restart_query_error_is_fail_soft_after_exact_setting_restoration() {
        let fixture = WalFixture::new(1_000);
        fixture.append_pages(16);
        let before = fixture.checkpoint(OpenWalCheckpointMode::Noop);
        fixture.set_auto_checkpoint(before.log_frames);
        fixture
            .database
            .with_conn(|conn| {
                conn.busy_timeout(Duration::from_millis(2_345))?;
                let mut checkpoint = |conn: &Connection, mode: OpenWalCheckpointMode| {
                    if mode == OpenWalCheckpointMode::Restart {
                        Err(SqliteError::InvalidQuery)
                    } else {
                        sqlite_wal_checkpoint(conn, mode)
                    }
                };
                let mut set_timeout = sqlite_set_busy_timeout;
                let outcome = prepare_wal_for_open_on_connection_with(
                    conn,
                    &mut checkpoint,
                    &mut set_timeout,
                )?;
                assert!(matches!(
                    outcome,
                    OpenWalPreparationOutcome::Noop {
                        reason: OpenWalNoopReason::CheckpointUnavailable,
                        error_code: Some(OpenWalErrorCode::CheckpointQuery),
                        ..
                    }
                ));
                Ok(())
            })
            .expect("fail-soft RESTART query");
        assert_eq!(fixture.busy_timeout_ms(), 2_345);
        assert_eq!(fixture.auto_checkpoint(), before.log_frames);
    }

    #[test]
    fn active_transaction_and_disabled_autocheckpoint_fail_before_checkpoint_work() {
        let fixture = WalFixture::new(8);
        fixture
            .database
            .with_conn(|conn| {
                conn.execute_batch("BEGIN")?;
                let mut checkpoint = sqlite_wal_checkpoint;
                let mut set_timeout = sqlite_set_busy_timeout;
                let error = prepare_wal_for_open_on_connection_with(
                    conn,
                    &mut checkpoint,
                    &mut set_timeout,
                )
                .expect_err("active transaction must fail before checkpoint work");
                assert!(error.to_string().contains("OPEN_WAL_ACTIVE_TRANSACTION"));
                conn.execute_batch("ROLLBACK")?;
                Ok(())
            })
            .expect("verify active transaction guard");

        let disabled = WalFixture::new(0);
        let error = prepare_wal_for_open(&disabled.database)
            .expect_err("disabled autocheckpoint must fail the open invariant");
        assert!(error
            .to_string()
            .contains("OPEN_WAL_AUTOCHECKPOINT_MUST_BE_POSITIVE"));
        assert_eq!(disabled.auto_checkpoint(), 0);
    }
}
