//! Read-only diagnostic: replay the material membership of every current
//! Chronicle revision of one project and summarize it by Run window count.
//! It prints counts, id prefixes, reason codes and digests only, never any
//! manuscript text. Run it before and after a replay change on a private copy
//! of a database and compare `resultDigest` per revision.
use anyhow::{ensure, Result};
use grimodex_db::narrative_extraction::{
    read_revision_material_membership, MaterialMembershipRead,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::Instant;

fn prefix(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    ensure!(
        args.len() >= 3,
        "usage: nir1_multi_window_membership_probe <database copy> <project-id> [window-count]"
    );
    let only_windows: Option<u64> = args.get(3).map(|v| v.parse()).transpose()?;
    let conn = Connection::open_with_flags(&args[1], OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let rows = {
        let mut stmt = conn.prepare(
            "SELECT p.current_revision_id, s.run_id, run.coverage_json
             FROM narrative_proposals p
             JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
             JOIN narrative_extraction_runs run ON run.id = s.run_id AND run.project_id = s.project_id
             WHERE s.project_id = ?1 AND p.current_revision_id IS NOT NULL
             ORDER BY s.run_id, p.id",
        )?;
        let rows = stmt
            .query_map([&args[2]], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut results = vec![];
    // window count -> outcome label -> count
    let mut summary: BTreeMap<u64, BTreeMap<String, usize>> = BTreeMap::new();
    let mut run_ms: BTreeMap<String, f64> = BTreeMap::new();
    for (revision, run, coverage) in &rows {
        let coverage: Value = serde_json::from_str(coverage)?;
        let windows = coverage["windowCount"].as_u64().unwrap_or(0);
        if only_windows.is_some_and(|only| only != windows) {
            continue;
        }
        let tx = conn.unchecked_transaction()?;
        let start = Instant::now();
        let read = read_revision_material_membership(&tx, &args[2], revision)?;
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        drop(tx);
        *run_ms.entry(run.clone()).or_default() += ms;
        let (label, detail) = match read {
            MaterialMembershipRead::Complete(m) => {
                let mut contexts = std::collections::BTreeSet::new();
                for material in &m.materials {
                    contexts.insert(material.context_id.clone());
                }
                let body = serde_json::to_string(&json!({
                    "materials": m.materials, "requests": m.replayed_requests
                }))?;
                let digest = hex::encode(Sha256::digest(body.as_bytes()));
                (
                    "complete".to_owned(),
                    json!({
                        "materialCount": m.materials.len(),
                        "materialWindows": contexts.len(),
                        "requestCount": m.replayed_requests.len(),
                        "resultDigest": digest,
                    }),
                )
            }
            MaterialMembershipRead::Unavailable { status, issues } => {
                let codes = issues.iter().map(|i| i.code).collect::<Vec<_>>();
                (
                    format!("{status:?}:{}", codes.join("+")),
                    json!({ "status": format!("{status:?}"), "codes": codes }),
                )
            }
        };
        *summary
            .entry(windows)
            .or_default()
            .entry(label.clone())
            .or_default() += 1;
        results.push(json!({
            "revision": prefix(revision), "run": prefix(run), "windowCount": windows,
            "outcome": label, "detail": detail, "ms": ms
        }));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "diagnosticOnly": true,
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "projectId": args[2],
            "revisionCount": results.len(),
            "summaryByWindowCount": summary,
            "runTotalMs": run_ms,
            "revisions": results,
        }))?
    );
    Ok(())
}
