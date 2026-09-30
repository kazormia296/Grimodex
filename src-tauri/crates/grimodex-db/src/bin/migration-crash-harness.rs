use std::path::PathBuf;
use std::process;

use grimodex_db::migration_supervisor::{self, Failpoint};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        process::exit(2);
    }
}

fn run() -> anyhow::Result<()> {
    let args = Args::parse(std::env::args().skip(1))?;
    let outcome = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
        &args.workspace,
        Some(args.failpoint),
    )?;
    eprintln!("migration crash harness completed without parking: {outcome:?}");
    Ok(())
}

struct Args {
    workspace: PathBuf,
    failpoint: Failpoint,
}

impl Args {
    fn parse(mut args: impl Iterator<Item = String>) -> anyhow::Result<Self> {
        let mut workspace = None;
        let mut failpoint = None;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--workspace" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("--workspace requires a path"))?;
                    workspace = Some(PathBuf::from(value));
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
            failpoint: failpoint.ok_or_else(|| anyhow::anyhow!("missing --failpoint"))?,
        })
    }
}

fn parse_failpoint(value: &str) -> anyhow::Result<Failpoint> {
    match value {
        "after_snapshot" | "migration.after_snapshot" => Ok(Failpoint::AfterSnapshot),
        "after_staged_copy" | "migration.after_staged_copy" => Ok(Failpoint::AfterStagedCopy),
        "after_migrate" | "migration.after_migrate" => Ok(Failpoint::AfterMigrate),
        "after_replace" | "migration.after_replace" => Ok(Failpoint::AfterReplace),
        "before_reopen" | "migration.before_reopen" => Ok(Failpoint::BeforeReopen),
        "reopen_failure" | "migration.reopen_failure" => Ok(Failpoint::ReopenFailure),
        "shared_handoff_busy" | "migration.shared_handoff_busy" => Ok(Failpoint::SharedHandoffBusy),
        "checksum_mismatch" | "migration.checksum_mismatch" => Ok(Failpoint::ChecksumMismatch),
        "disk_full" | "migration.disk_full" => Ok(Failpoint::DiskFull),
        other => anyhow::bail!("unknown migration failpoint: {other}"),
    }
}
