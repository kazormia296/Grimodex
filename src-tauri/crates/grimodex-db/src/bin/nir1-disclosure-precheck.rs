//! Diagnostic only. Opens an existing DB read-only; never migrates it.
use anyhow::{ensure, Result};
use grimodex_db::narrative_extraction::disclosure_precheck::{
    inspect_disclosure_precheck, inspect_query_axis,
};
use rusqlite::{Connection, OpenFlags};
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let policy = args.get(1).is_some_and(|a| a == "--policy");
    ensure!(if policy {args.len()==7} else {args.len()==5},"usage: nir1-disclosure-precheck <database> <project-id> <revision-id> <query-scene-id> OR --axis-only <database> <project-id> <query-scene-id>");
    let axis_only = args[1] == "--axis-only";
    if policy {
        ensure!(
            args[2] == grimodex_db::narrative_extraction::disclosure_policy::POLICY_REF,
            "unsupported diagnostic policy"
        );
    }
    let db = if policy {
        &args[3]
    } else if axis_only {
        &args[2]
    } else {
        &args[1]
    };
    let mut conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let tx = conn.transaction()?;
    let report = if policy {
        grimodex_db::narrative_extraction::disclosure_policy::inspect_diagnostic_disclosure(
            &tx, &args[4], &args[5], &args[6],
        )?
    } else if axis_only {
        inspect_query_axis(&tx, &args[3], &args[4])?
    } else {
        inspect_disclosure_precheck(&tx, &args[2], &args[3], &args[4])?
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
