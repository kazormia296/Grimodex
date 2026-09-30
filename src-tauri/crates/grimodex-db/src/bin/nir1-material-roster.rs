//! Opt-in diagnostic only: opens existing DB read-only and never migrates it.
use anyhow::{ensure, Result};
use grimodex_db::narrative_extraction::material_roster::inspect_material_roster;
use rusqlite::{Connection, OpenFlags};

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 4,
        "usage: nir1-material-roster <database> <project-id> <revision-id>"
    );
    let mut conn = Connection::open_with_flags(&args[1], OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let tx = conn.transaction()?;
    let report = inspect_material_roster(&tx, &args[2], &args[3])?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    // Exit success means the diagnostic ran, never that membership is complete.
    Ok(())
}
