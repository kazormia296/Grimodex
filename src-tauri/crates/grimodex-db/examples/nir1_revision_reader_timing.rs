//! Bounded read-only diagnostic. This is not an Electron latency receipt.
use anyhow::{ensure, Context, Result};
use grimodex_db::narrative_extraction::{
    read_revision_canonical_freshness, read_revision_material_membership, MaterialMembershipRead,
    RevisionFreshnessRead,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use std::time::Instant;

fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    ensure!(
        args.len() == 4,
        "expected DB path, project ID and revision ID"
    );
    let conn = Connection::open_with_flags(&args[1], OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut results = vec![];
    for arm in ["membership", "canonical"] {
        let mut samples = vec![];
        for iteration in 0..105 {
            let start = Instant::now();
            let tx = conn.unchecked_transaction()?;
            if arm == "membership" {
                ensure!(
                    matches!(
                        read_revision_material_membership(&tx, &args[2], &args[3])?,
                        MaterialMembershipRead::Complete(_)
                    ),
                    "membership must be complete in every sample"
                );
            } else {
                ensure!(
                    matches!(
                        read_revision_canonical_freshness(&tx, &args[2], &args[3])?,
                        RevisionFreshnessRead::Fresh(_)
                    ),
                    "canonical state must be fresh in every sample"
                );
            }
            drop(tx);
            if iteration >= 5 {
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        samples.sort_by(f64::total_cmp);
        results.push(json!({
            "arm": arm, "warmupCount": 5, "measurementCount": samples.len(),
            "medianMs": (samples[49] + samples[50]) / 2.0,
            "p95Ms": samples[94], "maxMs": samples.last().context("sample")?,
            "samplesMsSorted": samples
        }));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "diagnosticOnly": true, "boundary": "read-only opened SQLite connection; transaction plus reader plus transaction close",
            "notMeasured": ["Electron", "IPC", "model", "Index", "response authority", "whole admission"],
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "results": results
        }))?
    );
    Ok(())
}
