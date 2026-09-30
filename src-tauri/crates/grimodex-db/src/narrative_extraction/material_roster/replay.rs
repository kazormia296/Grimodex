//! Candidate-scoped, one/two-window, identity-merge no-repair recipes.
//! This is deliberately narrower than every citation-ID production path.
use super::super::stage_provenance::VerifiedV2ContextArtifact;
use super::{array_at, prompt, required, segments, string_at};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection};
use serde_json::Value;

pub(super) struct AcceptedArtifact {
    pub id: String,
    pub digest: String,
    pub task_id: String,
    pub attempt_id: String,
    pub payload: Value,
}

/// Select an exact accepted Task/Attempt, never whichever artifact survived.
fn accepted(conn: &Connection, run: &str, task: &str, kind: &str) -> Result<AcceptedArtifact> {
    let mut stmt = conn.prepare("SELECT t.id, a.id, f.id, f.payload_digest, f.payload_json
        FROM narrative_extraction_tasks t JOIN narrative_extraction_attempts a
        ON a.task_id=t.id AND a.attempt_number=t.attempt_count AND a.status='completed'
        JOIN narrative_extraction_artifacts f ON f.run_id=t.run_id AND f.task_id=t.id AND f.attempt_id=a.id
        WHERE t.run_id=?1 AND t.task_kind=?2 AND t.status='completed' AND f.artifact_kind=?3
        AND f.payload_storage='inline-json'")?;
    let rows = stmt
        .query_map(params![run, task, kind], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(rows.len() == 1, "accepted-artifact-roster-invalid");
    let (task_id, attempt_id, id, digest, payload) = rows
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("missing accepted artifact"))?;
    let payload: Value = serde_json::from_str(&payload)?;
    ensure!(
        grimodex_core::canonical_json_digest(&payload)? == digest,
        "accepted-artifact-digest-invalid"
    );
    Ok(AcceptedArtifact {
        id,
        digest,
        task_id,
        attempt_id,
        payload,
    })
}
fn owner(receipt: &Value, artifact: &AcceptedArtifact) -> bool {
    receipt["stageExecution"]["taskId"] == artifact.task_id
        && receipt["stageExecution"]["attemptId"] == artifact.attempt_id
}

pub(super) enum Outcome {
    Complete(Vec<segments::Material>, Vec<prompt::RequestProof>),
    Unsupported(&'static str),
}

pub(super) fn resolve(
    conn: &Connection,
    run: &str,
    root: &VerifiedV2ContextArtifact,
    coverage: &Value,
    receipts: &[Value],
    envelope: &Value,
) -> Result<Outcome> {
    for receipt in receipts {
        let stage = string_at(receipt, "/stageExecution/stageId")?;
        if stage == "narrative_structured_repair" {
            return Ok(Outcome::Unsupported(
                "citation-repair-recipe-not-implemented",
            ));
        }
        if ![prompt::OBSERVATION, prompt::SYNTHESIS].contains(&stage.as_str())
            || receipt["componentContractDigest"] != prompt::contract_digest(&stage)?
            || receipt["contextSetVersion"] != "chronicle.context-set/1"
        {
            return Ok(Outcome::Unsupported("component-recipe-unsupported"));
        }
        ensure!(
            receipt["terminalStatus"] == "succeeded"
                && receipt["parseStatus"] == "parsed"
                && receipt["stageExecution"]["parentStageExecutionId"].is_null(),
            "no-repair-terminal-binding-invalid"
        );
    }
    let snapshot = accepted(conn, run, "source.snapshot@1", "source.snapshot@1")?;
    let plan = accepted(conn, run, "source.window-plan@1", "source.window-plan@1")?;
    let windows = array_at(&plan.payload, "/windows")?;
    ensure!(
        coverage["windowCount"].as_u64() == Some(windows.len() as u64),
        "window-plan-coverage-mismatch"
    );
    if !(1..=2).contains(&windows.len()) {
        return Ok(Outcome::Unsupported("multi-window-recipe-not-implemented"));
    }
    if snapshot.payload["evidence"]["catalog"]["version"] != 1
        || snapshot.payload["evidence"]["catalog"]["segmentationVersion"] != "sentence-like-v1"
    {
        return Ok(Outcome::Unsupported("catalog-recipe-unsupported"));
    }
    let raw = accepted(
        conn,
        run,
        "chronicle.observe-events@1",
        "chronicle.raw-observations@1",
    )?;
    let merged = accepted(
        conn,
        run,
        "chronicle.merge-local-observations@1",
        "chronicle.merged-observations@1",
    )?;
    if raw.payload["observations"] != merged.payload["observations"] {
        return Ok(Outcome::Unsupported(
            "nonidentity-merge-recipe-not-implemented",
        ));
    }
    let clusters = accepted(
        conn,
        run,
        "chronicle.cluster-event-observations@1",
        "chronicle.event-clusters@1",
    )?;
    let synthesis = accepted(
        conn,
        run,
        "chronicle.synthesize-event@1",
        "chronicle.stage-synthesis-outputs@1",
    )?;
    ensure!(
        root.source_key == format!("artifact:{}", synthesis.id)
            && root.revision_token == synthesis.digest,
        "revision-companion-selection-mismatch"
    );
    let outputs = array_at(&synthesis.payload, "/outputs")?
        .iter()
        .filter(|o| o["clusterRef"] == root.cluster_ref)
        .collect::<Vec<_>>();
    ensure!(outputs.len() == 1, "synthesis-input-roster-invalid");
    let output = outputs[0];
    if output["disposition"] != "root-success" {
        return Ok(Outcome::Unsupported(
            "synthesis-terminal-recipe-unsupported",
        ));
    }
    ensure!(
        output["rootStageExecutionId"] == output["terminalStageExecutionId"],
        "synthesis-parent-binding-invalid"
    );
    let cluster = array_at(&clusters.payload, "/clusters")?
        .iter()
        .filter(|c| c["clusterRef"] == root.cluster_ref)
        .collect::<Vec<_>>();
    ensure!(cluster.len() == 1, "cluster-roster-invalid");
    let observations = array_at(output, "/rawObservations/observations")?;
    let ids: Vec<_> = observations
        .iter()
        .map(|o| string_at(o, "/localId"))
        .collect::<Result<_>>()?;
    ensure!(
        serde_json::to_value(&ids)? == cluster[0]["observationRefs"]
            && ids == root.observation_refs,
        "cluster-input-membership-mismatch"
    );
    let window_ids = windows
        .iter()
        .map(|w| string_at(w, "/windowId"))
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    ensure!(window_ids.len() == windows.len(), "duplicate-window-id");
    let all_observations = array_at(&raw.payload, "/observations")?;
    let mut all_ids = std::collections::BTreeSet::new();
    for o in all_observations {
        let id = string_at(o, "/localId")?;
        ensure!(
            window_ids
                .iter()
                .filter(|w| id.starts_with(&format!("{w}:")))
                .count()
                == 1
                && all_ids.insert(id),
            "observation-window-lineage-invalid"
        );
    }
    for o in observations {
        ensure!(
            all_observations
                .iter()
                .filter(|v| v["localId"] == o["localId"])
                .eq(std::iter::once(o)),
            "observation-lineage-mismatch"
        );
    }
    let obs_receipts = receipts
        .iter()
        .filter(|r| r["stageExecution"]["stageId"] == prompt::OBSERVATION)
        .collect::<Vec<_>>();
    ensure!(
        obs_receipts.len() == windows.len() && obs_receipts.iter().all(|r| owner(r, &raw)),
        "observation-request-roster-invalid"
    );
    let syn_receipts = receipts
        .iter()
        .filter(|r| r["stageExecution"]["stageExecutionId"] == output["rootStageExecutionId"])
        .collect::<Vec<_>>();
    ensure!(
        syn_receipts.len() == 1 && owner(syn_receipts[0], &synthesis),
        "synthesis-request-roster-invalid"
    );
    let required = required::windows(envelope, &snapshot.payload, windows, &ids)?;
    let mut materials = vec![];
    let mut proofs = vec![];
    let mut used_receipts = std::collections::BTreeSet::new();
    for window in windows {
        let window_id = string_at(window, "/windowId")?;
        let mut matches = vec![];
        for receipt in &obs_receipts {
            let (digests, segments) = segments::observation(&snapshot.payload, window, receipt)?;
            if digests.context_set_digest == receipt["contextSetDigest"] {
                let proof = prompt::proof(receipt, digests)?;
                matches.push((segments, proof));
            }
        }
        ensure!(
            matches.len() == 1,
            "observation-window-request-binding-invalid"
        );
        let (window_materials, proof) = matches
            .pop()
            .ok_or_else(|| anyhow::anyhow!("missing observation request"))?;
        ensure!(
            used_receipts.insert(proof.execution_id.clone()),
            "duplicate-window-request"
        );
        // Check evidence against its own ancestor request, including when
        // different windows expose overlapping canonical source ranges.
        for observation in observations.iter().filter(|o| {
            o["localId"]
                .as_str()
                .is_some_and(|id| id.starts_with(&format!("{window_id}:")))
        }) {
            for evidence in array_at(observation, "/evidence")? {
                let source_ref = string_at(evidence, "/sourceRef")?;
                let matches = window_materials
                    .iter()
                    .filter(|m| m.canonical_source_ref.as_deref() == Some(&source_ref))
                    .collect::<Vec<_>>();
                ensure!(
                    matches.len() == 1
                        && matches[0].content_digest
                            == grimodex_core::canonical_json_digest(&evidence["quote"])?,
                    "synthesis-source-material-binding-invalid"
                );
            }
        }
        if required.contains(&window_id) {
            materials.extend(window_materials);
            proofs.push(proof);
        }
    }
    let syn_proof = prompt::proof(
        syn_receipts[0],
        prompt::synthesis(&root.cluster_ref, observations)?,
    )?;
    proofs.push(syn_proof);
    Ok(Outcome::Complete(materials, proofs))
}
