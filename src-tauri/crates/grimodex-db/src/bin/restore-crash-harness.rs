//! Parks at Safe Mode restore failpoints so a parent can SIGKILL the child.

use std::fs;
use std::path::PathBuf;
use std::process;
use std::sync::Mutex;

use grimodex_db::backup_restore::{
    install_staged_workspace_db, InstallStagedOptions, RestoreFailpoint,
};
use grimodex_db::recovery::SafeModeSession;
use grimodex_db::state::WorkspaceState;
use grimodex_db::workspace_lease;
use grimodex_db::Database;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        process::exit(2);
    }
}

/// Concurrent-shared-writer mode: acquire a shared lease, commit a WAL-only
/// marker, then hold an open read transaction until the parent signals exit.
/// The parent uses this to prove that a restore publish never checkpoints,
/// seals, or deletes the WAL another shared authority is writing after the
/// exclusive→shared handoff.
fn run_wal_writer(
    workspace: &std::path::Path,
    ready_path: &std::path::Path,
    exit_path: &std::path::Path,
) -> anyhow::Result<()> {
    use rusqlite::config::DbConfig;
    use rusqlite::params;
    use std::time::{Duration, Instant};

    let _lease = workspace_lease::acquire_shared(workspace, Duration::from_secs(30))
        .map_err(|error| anyhow::anyhow!("writer shared lease: {error}"))?;
    let conn = rusqlite::Connection::open(workspace.join("grimodex.db"))?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "wal_autocheckpoint", 0)?;
    conn.busy_timeout(Duration::from_secs(10))?;
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        params!["gate-a2.wal-only", "committed only in wal"],
    )?;
    // Hold an open read transaction so an illegal post-handoff
    // checkpoint/seal cannot silently truncate the WAL under this reader.
    conn.execute_batch("BEGIN")?;
    let _count: i64 = conn.query_row("SELECT COUNT(*) FROM app_settings", [], |row| row.get(0))?;
    fs::write(ready_path, "writer-ready\n")?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while !exit_path.exists() {
        anyhow::ensure!(
            Instant::now() < deadline,
            "wal writer timed out waiting for the exit signal"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    conn.execute_batch("ROLLBACK")?;
    Ok(())
}

fn run() -> anyhow::Result<()> {
    let args = Args::parse(std::env::args().skip(1))?;
    if let ArgsMode::WalWriter {
        ready_path,
        exit_path,
    } = &args.mode
    {
        return run_wal_writer(&args.workspace, ready_path, exit_path);
    }
    let ArgsMode::Restore {
        candidate,
        failpoint,
    } = &args.mode
    else {
        anyhow::bail!("unsupported harness mode");
    };
    let db_path = args.workspace.join("grimodex.db");
    let staged = args.workspace.join("staged-restore-crash.db");
    if !candidate.exists() {
        anyhow::bail!("candidate missing: {}", candidate.display());
    }
    fs::copy(candidate, &staged)?;

    let state = WorkspaceState {
        inner: Mutex::new(None),
        safe_mode: grimodex_db::recovery::SafeModeState::default(),
        switching: std::sync::atomic::AtomicBool::new(false),
        open_lock: Mutex::new(()),
    };
    let session = SafeModeSession::from_workspace(
        args.workspace.clone(),
        "restore crash harness".into(),
        Some("RESTORE_CRASH_HARNESS".into()),
        None,
    )?;
    state.safe_mode.enter(session)?;

    // Ensure staged is a migratable image.
    {
        let db = Database::new(&staged)?;
        db.migrate()?;
    }

    let exclusive = workspace_lease::acquire_exclusive_for_migration(&args.workspace)?;
    let result = install_staged_workspace_db(
        &state,
        &args.workspace,
        &staged,
        InstallStagedOptions::safe_mode_with_failpoint(exclusive, *failpoint),
    );
    eprintln!("restore crash harness completed without parking: {result:?}");
    let _ = db_path;
    Ok(())
}

enum ArgsMode {
    Restore {
        candidate: PathBuf,
        failpoint: RestoreFailpoint,
    },
    WalWriter {
        ready_path: PathBuf,
        exit_path: PathBuf,
    },
}

struct Args {
    workspace: PathBuf,
    mode: ArgsMode,
}

impl Args {
    fn parse(mut args: impl Iterator<Item = String>) -> anyhow::Result<Self> {
        let mut workspace = None;
        let mut candidate = None;
        let mut failpoint = None;
        let mut wal_writer_ready = None;
        let mut wal_writer_exit = None;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--workspace" => {
                    workspace =
                        Some(PathBuf::from(args.next().ok_or_else(|| {
                            anyhow::anyhow!("--workspace requires a path")
                        })?));
                }
                "--candidate" => {
                    candidate =
                        Some(PathBuf::from(args.next().ok_or_else(|| {
                            anyhow::anyhow!("--candidate requires a path")
                        })?));
                }
                "--failpoint" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("--failpoint requires a name"))?;
                    failpoint = Some(parse_failpoint(&value)?);
                }
                "--wal-writer-ready" => {
                    wal_writer_ready =
                        Some(PathBuf::from(args.next().ok_or_else(|| {
                            anyhow::anyhow!("--wal-writer-ready requires a path")
                        })?));
                }
                "--wal-writer-exit" => {
                    wal_writer_exit =
                        Some(PathBuf::from(args.next().ok_or_else(|| {
                            anyhow::anyhow!("--wal-writer-exit requires a path")
                        })?));
                }
                other => anyhow::bail!("unknown argument: {other}"),
            }
        }
        let workspace = workspace.ok_or_else(|| anyhow::anyhow!("missing --workspace"))?;
        let mode = match (wal_writer_ready, wal_writer_exit) {
            (Some(ready_path), Some(exit_path)) => {
                anyhow::ensure!(
                    candidate.is_none() && failpoint.is_none(),
                    "wal-writer mode takes no candidate/failpoint"
                );
                ArgsMode::WalWriter {
                    ready_path,
                    exit_path,
                }
            }
            (None, None) => ArgsMode::Restore {
                candidate: candidate.ok_or_else(|| anyhow::anyhow!("missing --candidate"))?,
                failpoint: failpoint.ok_or_else(|| anyhow::anyhow!("missing --failpoint"))?,
            },
            _ => anyhow::bail!(
                "wal-writer mode requires both --wal-writer-ready and --wal-writer-exit"
            ),
        };
        Ok(Self { workspace, mode })
    }
}

fn parse_failpoint(value: &str) -> anyhow::Result<RestoreFailpoint> {
    match value {
        "after_rollback_snapshot" | "restore.after_rollback_snapshot" => {
            Ok(RestoreFailpoint::AfterRollbackSnapshot)
        }
        "after_live_seal" | "restore.after_live_seal" => Ok(RestoreFailpoint::AfterLiveSeal),
        "fail_atomic_replace" | "restore.fail_atomic_replace" => {
            Ok(RestoreFailpoint::FailAtomicReplace)
        }
        "after_replace" | "restore.after_replace" => Ok(RestoreFailpoint::AfterReplace),
        "before_live_verify" | "restore.before_live_verify" => {
            Ok(RestoreFailpoint::BeforeLiveVerify)
        }
        "live_verify_failure" | "restore.live_verify_failure" => {
            Ok(RestoreFailpoint::LiveVerifyFailure)
        }
        other => anyhow::bail!("unknown restore failpoint: {other}"),
    }
}
