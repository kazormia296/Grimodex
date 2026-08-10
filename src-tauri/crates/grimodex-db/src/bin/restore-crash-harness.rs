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

fn run() -> anyhow::Result<()> {
    let args = Args::parse(std::env::args().skip(1))?;
    let db_path = args.workspace.join("grimodex.db");
    let staged = args.workspace.join("staged-restore-crash.db");
    if !args.candidate.exists() {
        anyhow::bail!("candidate missing: {}", args.candidate.display());
    }
    fs::copy(&args.candidate, &staged)?;

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
        InstallStagedOptions::safe_mode_with_failpoint(exclusive, args.failpoint),
    );
    eprintln!("restore crash harness completed without parking: {result:?}");
    let _ = db_path;
    Ok(())
}

struct Args {
    workspace: PathBuf,
    candidate: PathBuf,
    failpoint: RestoreFailpoint,
}

impl Args {
    fn parse(mut args: impl Iterator<Item = String>) -> anyhow::Result<Self> {
        let mut workspace = None;
        let mut candidate = None;
        let mut failpoint = None;
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
                other => anyhow::bail!("unknown argument: {other}"),
            }
        }
        Ok(Self {
            workspace: workspace.ok_or_else(|| anyhow::anyhow!("missing --workspace"))?,
            candidate: candidate.ok_or_else(|| anyhow::anyhow!("missing --candidate"))?,
            failpoint: failpoint.ok_or_else(|| anyhow::anyhow!("missing --failpoint"))?,
        })
    }
}

fn parse_failpoint(value: &str) -> anyhow::Result<RestoreFailpoint> {
    match value {
        "after_rollback_snapshot" | "restore.after_rollback_snapshot" => {
            Ok(RestoreFailpoint::AfterRollbackSnapshot)
        }
        "after_live_seal" | "restore.after_live_seal" => Ok(RestoreFailpoint::AfterLiveSeal),
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
