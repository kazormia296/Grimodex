//! Opt-in NIR-1 whole-project capacity diagnostic.
//!
//! This binary runs the writeful Graph prepare/publish/restore lifecycle on a
//! disposable child database and reports the current A2 reader boundary plus
//! process/resource observations. The preseed source database is expected to
//! remain closed, checkpointed, and immutable; only the disposable child may
//! be mutated. It never claims a supported Graph build capacity.

use anyhow::{ensure, Result};
use grimodex_db::narrative_extraction::nir1_capacity_diagnostics::measure_capacity;
use grimodex_db::narrative_extraction::nir1_capacity_fixtures::build_fixture_from_manifest;
use std::path::Path;

fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).is_some_and(|arg| arg == "fixture") {
        ensure!(
            args.len() == 5,
            "usage: nir1-material-capacity fixture <manifest> <case-id> <output.db>"
        );
        let result =
            build_fixture_from_manifest(Path::new(&args[2]), &args[3], Path::new(&args[4]))?;
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
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
