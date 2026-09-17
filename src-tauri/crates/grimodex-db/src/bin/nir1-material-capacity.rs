//! Opt-in, read-only NIR-1 whole-project capacity diagnostic.
//!
//! This binary reports the current A2 reader boundary and process/resource
//! observations. It never migrates, writes, publishes, or claims a supported
//! Graph build capacity.

use anyhow::{ensure, Result};
use grimodex_db::narrative_extraction::nir1_capacity_diagnostics::measure_capacity;
use std::path::Path;

fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    ensure!(
        (3..=4).contains(&args.len()),
        "usage: nir1-material-capacity <database> <fixture-id> [project-id]"
    );
    let observation = measure_capacity(
        Path::new(&args[1]),
        &args[2],
        args.get(3).map(String::as_str),
    )?;
    println!("{}", serde_json::to_string_pretty(&observation)?);
    Ok(())
}
