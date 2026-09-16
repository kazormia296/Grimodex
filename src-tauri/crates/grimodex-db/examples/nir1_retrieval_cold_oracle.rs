//! Read-only diagnostic over every current Chronicle revision in one project.
use anyhow::{ensure, Result};
use grimodex_db::narrative_extraction::{
    read_revision_retrieval_eligibility, RevisionEligibilityRead,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use std::time::Instant;

fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    ensure!(
        args.len() == 4,
        "expected DB path, project ID and query Scene ID"
    );
    let conn = Connection::open_with_flags(&args[1], OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let tx = conn.unchecked_transaction()?;
    let revisions = tx
        .prepare(
            "SELECT p.current_revision_id FROM narrative_proposals p
         JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id
         WHERE s.project_id=?1 AND p.current_revision_id IS NOT NULL
         ORDER BY p.id",
        )?
        .query_map([&args[2]], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let start = Instant::now();
    let mut eligible = vec![];
    let mut unavailable = vec![];
    for revision in &revisions {
        match read_revision_retrieval_eligibility(&tx, &args[2], revision, &args[3])? {
            RevisionEligibilityRead::Eligible(snapshot) => eligible.push(json!({
                "revisionId": snapshot.revision_id(), "owningRunId": snapshot.owning_run_id(),
                "envelopeDigest": snapshot.envelope_digest(), "decisionId": snapshot.current_decision_id(),
                "statementDigest": snapshot.document().serialized_statement_digest,
                "evidenceCount": snapshot.evidence().len(),
                "sourceKeys": snapshot.evidence().iter().map(|e| &e.source_key).collect::<Vec<_>>()
            })),
            RevisionEligibilityRead::Unavailable { reason } => unavailable.push(json!({
                "revisionId": revision, "reason": format!("{reason:?}")
            })),
        }
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "diagnosticOnly": true, "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "projectId": args[2], "querySceneId": args[3], "currentRevisionCount": revisions.len(),
            "elapsedMs": start.elapsed().as_secs_f64() * 1000.0,
            "eligibleCount": eligible.len(), "unavailableCount": unavailable.len(),
            "eligible": eligible, "unavailable": unavailable,
            "notMeasured": ["Index", "embedding", "Electron", "quality", "runtime liveness"]
        }))?
    );
    Ok(())
}
