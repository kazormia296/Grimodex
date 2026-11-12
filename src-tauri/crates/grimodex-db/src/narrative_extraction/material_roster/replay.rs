//! Candidate-scoped, one-or-more-window, identity-merge no-repair recipes.
//! This is deliberately narrower than every citation-ID production path.
//!
//! What a window contributes (its materials and the check of its observation
//! request against the persisted receipt) depends only on the sealed
//! snapshot, the window plan and the receipts of the Run, never on the Root.
//! `RunReplay` builds it once per window and reuses it for every Root of the
//! Run read under the same memo.
use super::super::stage_provenance::VerifiedV2ContextArtifact;
#[cfg(test)]
use super::RunProofMemo;
use super::{array_at, prompt, required, segments, string_at};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::rc::Rc;

pub(super) struct AcceptedArtifact {
    pub id: String,
    pub digest: String,
    pub task_id: String,
    pub attempt_id: String,
    pub payload: Value,
}

/// Select an exact accepted Task/Attempt, never whichever artifact survived.
pub(super) fn accepted(
    conn: &Connection,
    run: &str,
    task: &str,
    kind: &str,
) -> Result<AcceptedArtifact> {
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

/// A window's materials and its request proof, once its observation request
/// was rebuilt and matched exactly one persisted receipt.
struct WindowBinding {
    materials: Vec<segments::Material>,
    proof: prompt::RequestProof,
    /// canonical source ref -> (how many materials carry it, the first one)
    by_source_ref: HashMap<String, (usize, usize)>,
}

/// Everything a cached value was derived from. A cache built for other inputs
/// is dropped, so a stale value can never be matched to a different Run state.
#[derive(PartialEq, Eq)]
struct Fingerprint {
    snapshot: String,
    plan: String,
    raw: String,
    merged: String,
    observation_receipts: Vec<(String, String)>,
}

/// Root-independent replay results of ONE Run. Only successes are kept: a
/// failure is raised again, from the same verifier, by the next Root.
#[derive(Default)]
pub(super) struct RunReplay {
    fingerprint: Option<Fingerprint>,
    segments: segments::SnapshotSegments,
    windows: HashMap<String, Rc<WindowBinding>>,
    identity_merge: bool,
    window_lineage: bool,
    /// (stage, component contract digest) pairs found among the frozen
    /// accepted contracts. Looking one up parses and digests every frozen
    /// contract, which used to happen once per receipt per Root.
    accepted_contracts: HashSet<(String, String)>,
}

impl RunReplay {
    /// Whether `digest` names a frozen accepted contract of `stage`. Only a
    /// hit is remembered; a miss is looked up again, as before.
    fn accepts_contract(&mut self, stage: &str, digest: &str) -> Result<bool> {
        let key = (stage.to_owned(), digest.to_owned());
        if self.accepted_contracts.contains(&key) {
            return Ok(true);
        }
        let accepted = prompt::accepted_contract(stage, digest)?.is_some();
        if accepted {
            self.accepted_contracts.insert(key);
        }
        Ok(accepted)
    }

    fn keep_only_for(&mut self, fingerprint: Fingerprint) {
        if self.fingerprint.as_ref() != Some(&fingerprint) {
            // The frozen contracts do not depend on the Run.
            let contracts = std::mem::take(&mut self.accepted_contracts);
            *self = Self::default();
            self.accepted_contracts = contracts;
            self.fingerprint = Some(fingerprint);
        }
    }

    /// Rebuild the observation request of one window and match it with the
    /// persisted receipts. The context-set digest names the request, so only
    /// receipts that carry it are rebuilt; each rebuilt one must also prove all
    /// three digests, and exactly one receipt may carry it.
    fn bind_window(
        &mut self,
        snapshot: &Value,
        window: &Value,
        window_id: &str,
        observation_receipts: &[&Value],
    ) -> Result<Rc<WindowBinding>> {
        if let Some(bound) = self.windows.get(window_id) {
            return Ok(Rc::clone(bound));
        }
        let context = prompt::observation_window_context_digest(window_id)?;
        let mut matches = vec![];
        for receipt in observation_receipts {
            if receipt["contextSetDigest"] != context {
                continue;
            }
            let (digests, materials) = self.segments.observation(snapshot, window, receipt)?;
            let proof = prompt::proof(receipt, digests)?;
            matches.push((materials, proof));
        }
        ensure!(
            matches.len() == 1,
            "observation-window-request-binding-invalid"
        );
        let (materials, proof) = matches
            .pop()
            .ok_or_else(|| anyhow::anyhow!("missing observation request"))?;
        let mut by_source_ref: HashMap<String, (usize, usize)> = HashMap::new();
        for (index, material) in materials.iter().enumerate() {
            if let Some(source_ref) = &material.canonical_source_ref {
                by_source_ref
                    .entry(source_ref.clone())
                    .or_insert((0, index))
                    .0 += 1;
            }
        }
        let bound = Rc::new(WindowBinding {
            materials,
            proof,
            by_source_ref,
        });
        self.windows.insert(window_id.to_owned(), Rc::clone(&bound));
        Ok(bound)
    }
}

/// Reads one accepted artifact of the Run by (task kind, artifact kind).
pub(super) type LoadAccepted<'a> = dyn FnMut(&str, &str) -> Result<Rc<AcceptedArtifact>> + 'a;

/// `resolve_cached` with a Run cache that lives only for this call.
#[cfg(test)]
pub(super) fn resolve(
    conn: &Connection,
    memo: &mut RunProofMemo,
    run: &str,
    root: &VerifiedV2ContextArtifact,
    coverage: &Value,
    receipts: &[Value],
    envelope: &Value,
) -> Result<Outcome> {
    resolve_cached(
        &mut RunReplay::default(),
        &mut |task, kind| memo.accepted_artifact(conn, run, task, kind),
        root,
        coverage,
        receipts,
        envelope,
    )
}

pub(super) fn resolve_cached(
    cache: &mut RunReplay,
    load: &mut LoadAccepted<'_>,
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
        let accepted_contract = match receipt["componentContractDigest"].as_str() {
            Some(digest) => cache.accepts_contract(&stage, digest)?,
            None => false,
        };
        if ![prompt::OBSERVATION, prompt::SYNTHESIS].contains(&stage.as_str())
            || !accepted_contract
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
    let snapshot = load("source.snapshot@1", "source.snapshot@1")?;
    let plan = load("source.window-plan@1", "source.window-plan@1")?;
    let windows = array_at(&plan.payload, "/windows")?;
    ensure!(
        coverage["windowCount"].as_u64() == Some(windows.len() as u64),
        "window-plan-coverage-mismatch"
    );
    // A Run without a window has nothing to replay. Every other count is
    // bound the same way: each window needs its own request and receipt.
    if windows.is_empty() {
        return Ok(Outcome::Unsupported("multi-window-recipe-not-implemented"));
    }
    if snapshot.payload["evidence"]["catalog"]["version"] != 1
        || snapshot.payload["evidence"]["catalog"]["segmentationVersion"] != "sentence-like-v1"
    {
        return Ok(Outcome::Unsupported("catalog-recipe-unsupported"));
    }
    let raw = load("chronicle.observe-events@1", "chronicle.raw-observations@1")?;
    let merged = load(
        "chronicle.merge-local-observations@1",
        "chronicle.merged-observations@1",
    )?;
    cache.keep_only_for(Fingerprint {
        snapshot: snapshot.digest.clone(),
        plan: plan.digest.clone(),
        raw: raw.digest.clone(),
        merged: merged.digest.clone(),
        observation_receipts: receipts
            .iter()
            .filter(|r| r["stageExecution"]["stageId"] == prompt::OBSERVATION)
            .map(|r| {
                (
                    r["stageExecution"]["stageExecutionId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    r["stageExecutionReceiptDigest"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                )
            })
            .collect(),
    });
    if !cache.identity_merge {
        if raw.payload["observations"] != merged.payload["observations"] {
            return Ok(Outcome::Unsupported(
                "nonidentity-merge-recipe-not-implemented",
            ));
        }
        cache.identity_merge = true;
    }
    let clusters = load(
        "chronicle.cluster-event-observations@1",
        "chronicle.event-clusters@1",
    )?;
    let synthesis = load(
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
        .collect::<Result<BTreeSet<_>>>()?;
    ensure!(window_ids.len() == windows.len(), "duplicate-window-id");
    let all_observations = array_at(&raw.payload, "/observations")?;
    if !cache.window_lineage {
        let mut all_ids = BTreeSet::new();
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
        cache.window_lineage = true;
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
    let mut used_receipts = BTreeSet::new();
    for window in windows {
        let window_id = string_at(window, "/windowId")?;
        // Built on the first Root that reaches this window, one window at a
        // time, so the first failure a Root meets is the one it always met.
        let bound = cache.bind_window(&snapshot.payload, window, &window_id, &obs_receipts)?;
        ensure!(
            used_receipts.insert(bound.proof.execution_id.clone()),
            "duplicate-window-request"
        );
        // Check evidence against its own ancestor request, including when
        // different windows expose overlapping canonical source ranges.
        let prefix = format!("{window_id}:");
        for observation in observations.iter().filter(|o| {
            o["localId"]
                .as_str()
                .is_some_and(|id| id.starts_with(&prefix))
        }) {
            for evidence in array_at(observation, "/evidence")? {
                let source_ref = string_at(evidence, "/sourceRef")?;
                let bound_material = match bound.by_source_ref.get(&source_ref) {
                    Some(&(1, index)) => {
                        bound.materials[index].content_digest
                            == grimodex_core::canonical_json_digest(&evidence["quote"])?
                    }
                    _ => false,
                };
                ensure!(bound_material, "synthesis-source-material-binding-invalid");
            }
        }
        if required.contains(&window_id) {
            materials.extend(bound.materials.iter().cloned());
            proofs.push(bound.proof.clone());
        }
    }
    let syn_proof = prompt::proof(
        syn_receipts[0],
        prompt::synthesis(
            &root.cluster_ref,
            &string_at(syn_receipts[0], "/componentContractDigest")?,
            observations,
        )?,
    )?;
    proofs.push(syn_proof);
    Ok(Outcome::Complete(materials, proofs))
}
