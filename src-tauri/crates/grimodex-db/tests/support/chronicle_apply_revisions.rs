use super::*;

/// The Native operation shape for importing a revision as an unmarked Chronicle event.
fn chronicle_apply_operation(conn: &Connection, run_id: &str, revision: &str) -> Value {
    let (payload, envelope): (String, String) = conn
        .query_row(
            "SELECT payload_json, reconciliation_envelope_json
               FROM narrative_proposal_revisions WHERE id = ?1",
            [revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("approved revision payload and Envelope");
    let payload: Value = serde_json::from_str(&payload).expect("revision payload");
    let envelope: Value = serde_json::from_str(&envelope).expect("revision Envelope");
    let snapshot: String = conn
        .query_row(
            "SELECT payload_json FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = 'source.snapshot@1'",
            [run_id],
            |row| row.get(0),
        )
        .expect("sealed Snapshot artifact");
    let snapshot: Value = serde_json::from_str(&snapshot).expect("Snapshot JSON");
    let documents = snapshot["snapshot"]["documents"]
        .as_array()
        .expect("Snapshot documents");
    let evidence_set = envelope
        .pointer("/effectiveMaterialBasis/evidenceSet")
        .or_else(|| envelope.get("evidenceSet"))
        .and_then(Value::as_array)
        .expect("Envelope evidenceSet");
    let anchors = payload["evidenceAnchorIds"].as_array().expect("anchors");
    let mut links: Vec<Value> = Vec::new();
    for document_ref in payload["evidenceDocumentRefs"]
        .as_array()
        .expect("evidence document refs")
    {
        let document = documents
            .iter()
            .find(|document| document["ref"] == *document_ref)
            .expect("Snapshot document of the evidence ref");
        let anchor_ids: Vec<Value> = anchors
            .iter()
            .filter(|anchor| {
                evidence_set.iter().any(|evidence| {
                    evidence["evidenceRef"] == **anchor && evidence["documentRef"] == *document_ref
                })
            })
            .cloned()
            .collect();
        links.push(json!({
            "sceneId": document["origin"]["nodeId"],
            "expectedSceneVersion": document["origin"]["sourceVersion"],
            "evidenceAnchorIds": anchor_ids,
        }));
    }
    let reveal_ref = &payload["disclosure"]["revealDocumentRef"];
    documents
        .iter()
        .find(|document| document["ref"] == *reveal_ref)
        .expect("reveal Snapshot document");
    json!({
        "eventId": payload["eventId"],
        "title": payload["title"],
        "note": payload["note"],
        "kind": "generic",
        "precision": "unknown",
        "placement": { "mode": "append-tail", "afterOrdinal": null },
        "secret": false,
        "revealSceneId": null,
        "evidenceSceneLinks": links,
        "detail": null,
        "primaryCodexId": null,
        "locationCodexId": null,
        "participants": [],
        "startTime": null,
        "endTime": null,
        "startGranularity": "none",
        "endGranularity": "none",
    })
}

pub(super) fn prepare_and_apply_revisions(
    db: &Database,
    project: &str,
    run: &str,
    revisions: &[String],
    request_id: &str,
) {
    let prepare = db
        .with_conn(|conn| {
            let mut set_id = String::new();
            let mut operations = Vec::new();
            let mut applications = Vec::new();
            for revision in revisions {
                let (proposal, set): (String, String) = conn.query_row(
                    "SELECT p.id, p.proposal_set_id FROM narrative_proposals p
                       JOIN narrative_proposal_revisions r ON r.proposal_id = p.id
                      WHERE r.id = ?1",
                    [revision],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                set_id = set;
                operations.push(CommitOperation {
                    kind: "chronicle.event.create".to_owned(),
                    payload: chronicle_apply_operation(conn, run, revision),
                    proposal_id: proposal.clone(),
                    revision_id: revision.clone(),
                });
                applications.push(CommitApplicationRef {
                    proposal_id: proposal,
                    revision_id: revision.clone(),
                });
            }
            Ok(PrepareCommitPayload {
                project_id: project.to_owned(),
                run_id: run.to_owned(),
                proposal_set_id: set_id,
                request_id: request_id.to_owned(),
                plan_digest: "ignored".to_owned(),
                session_id: format!("session-{request_id}"),
                surface: Some("narrative-extraction".to_owned()),
                operations,
                applications,
                expected_tail_ordinal: None,
                entity_bindings: vec![],
                expected_calendar_version: None,
            })
        })
        .expect("prepare payload");
    let prepared = narrative_extraction_prepare_commit(db, prepare.clone()).expect("prepare");
    narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: prepare.project_id.clone(),
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .expect("preparedCommitId")
                .to_owned(),
            request_id: prepare.request_id.clone(),
            session_id: prepare.session_id.clone(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("apply");
}
