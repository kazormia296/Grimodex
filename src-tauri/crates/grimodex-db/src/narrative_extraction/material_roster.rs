//! Read-only feasibility probe, deliberately absent from default product builds.
//! Verified persisted rows are NOT a complete model-visible material roster.
//! Limited recipe replay proves source membership, never disclosure admission.

mod prompt;
mod replay;
mod segments;

use anyhow::Result;
use grimodex_core::{canonical_json_digest, narrative_ir::validate_chronicle_scene_event_v2};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use super::repository::load_verified_chronicle_snapshot_for_apply;
use super::stage_provenance::{
    load_v2_context_artifact, load_verified_stage_receipts_for_hydration,
};

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RosterStatus {
    Complete,
    Incomplete,
    Inconsistent,
    Unsupported,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterIssue {
    pub code: &'static str,
    pub binding: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedReceipt {
    pub execution_id: String,
    pub receipt_digest: String,
    pub stage_id: String,
    pub component_contract_digest: String,
    pub context_set_digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedArtifact {
    pub artifact_id: String,
    pub artifact_kind: String,
    pub digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialRosterReport {
    pub diagnostic_only: bool,
    pub status: RosterStatus,
    pub revision_id: String,
    pub run_id: Option<String>,
    pub protocol: Option<String>,
    pub recipe: Option<&'static str>,
    pub completion_scope: &'static str,
    pub verified_receipts: Vec<VerifiedReceipt>,
    pub verified_artifacts: Vec<VerifiedArtifact>,
    /// Source segments from all model-visible ancestor input, including gaps.
    /// Published only after both reconstructed requests match persisted seals.
    pub materials: Vec<segments::Material>,
    pub replayed_requests: Vec<prompt::RequestProof>,
    pub issues: Vec<RosterIssue>,
}

impl MaterialRosterReport {
    fn issue(&mut self, status: RosterStatus, code: &'static str, binding: &'static str) {
        self.status = status;
        self.issues.push(RosterIssue { code, binding });
    }
}

/// Uses only SELECTs and existing read validators. Caller must hold a coherent
/// read transaction (the diagnostic CLI opens SQLite READ_ONLY). SQL/I/O errors
/// remain errors, distinct from missing proof, unsupported recipe and corruption.
/// Does not evaluate approval, Freshness or disclosure and cannot authorize IR.
pub fn inspect_material_roster(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
) -> Result<MaterialRosterReport> {
    anyhow::ensure!(
        !project_id.trim().is_empty() && !revision_id.trim().is_empty(),
        "nonempty identity required"
    );
    let mut report = MaterialRosterReport {
        diagnostic_only: true,
        status: RosterStatus::Incomplete,
        revision_id: revision_id.to_owned(),
        run_id: None,
        protocol: None,
        recipe: None,
        completion_scope: "source-material-membership-only",
        verified_receipts: vec![],
        verified_artifacts: vec![],
        materials: vec![],
        replayed_requests: vec![],
        issues: vec![],
    };
    let root: Option<(String, Option<String>, Option<String>, String)> = conn
        .query_row(
            "SELECT s.run_id, r.reconciliation_envelope_json, r.reconciliation_envelope_digest,
                run.coverage_json
         FROM narrative_proposal_revisions r
         JOIN narrative_proposals p ON p.id = r.proposal_id
         JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
         JOIN narrative_extraction_runs run ON run.id = s.run_id AND run.project_id = s.project_id
         WHERE r.id = ?1 AND s.project_id = ?2",
            params![revision_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((run_id, envelope_json, envelope_digest, coverage_json)) = root else {
        report.issue(
            RosterStatus::Incomplete,
            "revision-not-found",
            "project/revision",
        );
        return Ok(report);
    };
    report.run_id = Some(run_id.clone());
    let Some(envelope_json) = envelope_json else {
        report.issue(
            RosterStatus::Unsupported,
            "envelope-unavailable",
            "revision/envelope-v2",
        );
        return Ok(report);
    };
    let envelope: Value = match serde_json::from_str(&envelope_json) {
        Ok(value) => value,
        Err(_) => {
            report.issue(
                RosterStatus::Inconsistent,
                "envelope-json-invalid",
                "revision/envelope",
            );
            return Ok(report);
        }
    };
    if canonical_json_digest(&envelope)? != envelope_digest.unwrap_or_default() {
        report.issue(
            RosterStatus::Inconsistent,
            "envelope-digest-mismatch",
            "revision/envelope",
        );
        return Ok(report);
    }
    if envelope.get("schemaVersion").and_then(Value::as_u64) != Some(2) {
        report.issue(
            RosterStatus::Unsupported,
            "envelope-version-unsupported",
            "revision/envelope-v2",
        );
        return Ok(report);
    }
    if validate_chronicle_scene_event_v2(&envelope).is_err() {
        report.issue(
            RosterStatus::Inconsistent,
            "envelope-binding-invalid",
            "revision/envelope-v2",
        );
        return Ok(report);
    }
    // Check the REQUIRED roster first; hydration of surviving rows is not enough.
    let context_root =
        match load_v2_context_artifact(conn, project_id, &run_id, revision_id, &envelope) {
            Ok(root) => root,
            Err(error) => {
                if error.downcast_ref::<rusqlite::Error>().is_some() {
                    return Err(error);
                }
                report.issue(
                    RosterStatus::Inconsistent,
                    "revision-terminal-binding-invalid",
                    "revision/required-receipt-roster/synthesis-artifact",
                );
                return Ok(report);
            }
        };
    let receipts = match load_verified_stage_receipts_for_hydration(conn, project_id, &run_id) {
        Ok(value) => value,
        Err(error) => {
            if error.downcast_ref::<rusqlite::Error>().is_some() {
                return Err(error);
            }
            report.issue(
                RosterStatus::Inconsistent,
                "receipt-hydration-invalid",
                "receipt/model-binding/task-attempt/audit",
            );
            return Ok(report);
        }
    };
    for receipt in &receipts {
        report.verified_receipts.push(VerifiedReceipt {
            execution_id: string_at(receipt, "/stageExecution/stageExecutionId")?,
            receipt_digest: string_at(receipt, "/stageExecutionReceiptDigest")?,
            stage_id: string_at(receipt, "/stageExecution/stageId")?,
            component_contract_digest: string_at(receipt, "/componentContractDigest")?,
            context_set_digest: string_at(receipt, "/contextSetDigest")?,
        });
    }
    let mut stmt = conn.prepare(
        "SELECT id, artifact_kind, payload_json, payload_digest FROM narrative_extraction_artifacts
         WHERE run_id = ?1 ORDER BY id",
    )?;
    let artifacts = stmt
        .query_map([&run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut snapshots = vec![];
    for (id, kind, payload, digest) in artifacts {
        let (Some(payload), Some(digest)) = (payload, digest) else {
            report.issue(
                RosterStatus::Incomplete,
                "artifact-inline-binding-missing",
                "artifact/payload-digest",
            );
            continue;
        };
        let payload: Value = match serde_json::from_str(&payload) {
            Ok(value) => value,
            Err(_) => {
                report.issue(
                    RosterStatus::Inconsistent,
                    "artifact-json-invalid",
                    "artifact/payload",
                );
                return Ok(report);
            }
        };
        if canonical_json_digest(&payload)? != digest {
            report.issue(
                RosterStatus::Inconsistent,
                "artifact-digest-mismatch",
                match kind.as_str() {
                    "source.snapshot@1" => "snapshot/catalog/payload-digest",
                    "source.window-plan@1" => "window-plan/payload-digest",
                    _ => "artifact/payload",
                },
            );
            return Ok(report);
        }
        if kind == "source.snapshot@1" {
            snapshots.push(payload);
        }
        report.verified_artifacts.push(VerifiedArtifact {
            artifact_id: id,
            artifact_kind: kind,
            digest,
        });
    }
    if snapshots.is_empty() {
        report.issue(
            RosterStatus::Incomplete,
            "snapshot-binding-missing",
            "run/snapshot-task/artifact",
        );
        return Ok(report);
    }
    if snapshots.len() != 1 {
        report.issue(
            RosterStatus::Incomplete,
            "snapshot-selector-unresolved",
            "run/snapshot-task/accepted-attempt",
        );
        return Ok(report);
    }
    // Reuse the production reader's accepted Task/Attempt, Run seal, output
    // CAS and nested snapshot checks; hashing whichever snapshot survived is
    // not an independent membership seal.
    if let Err(error) = load_verified_chronicle_snapshot_for_apply(conn, project_id, &run_id) {
        if error.downcast_ref::<rusqlite::Error>().is_some() {
            return Err(error);
        }
        report.issue(
            RosterStatus::Inconsistent,
            "snapshot-authority-invalid",
            "run/task-attempt/output-cas/snapshot",
        );
        return Ok(report);
    }
    let coverage: Value = match serde_json::from_str(&coverage_json) {
        Ok(value) => value,
        Err(_) => {
            report.issue(
                RosterStatus::Inconsistent,
                "coverage-json-invalid",
                "run/coverage",
            );
            return Ok(report);
        }
    };
    let mode = coverage.get("evidenceMode").and_then(Value::as_str);
    if mode != Some("citation-id-v2") {
        report.issue(
            RosterStatus::Unsupported,
            "protocol-recipe-unresolved",
            "run/coverage/component-contract/input-protocol",
        );
        return Ok(report);
    }
    report.protocol = Some("citation-id-v2".into());
    if snapshots[0]
        .pointer("/evidence/mode")
        .and_then(Value::as_str)
        != mode
        || snapshots[0]
            .pointer("/evidence/catalog/entries")
            .and_then(Value::as_array)
            .is_none()
    {
        report.issue(
            RosterStatus::Inconsistent,
            "citation-companion-binding-invalid",
            "snapshot/evidence/catalog",
        );
        return Ok(report);
    }
    if coverage.get("evidenceCatalogDigest") != snapshots[0].pointer("/evidence/catalogDigest")
        || snapshots[0].pointer("/evidence/catalogDigest")
            != snapshots[0].pointer("/evidence/catalog/digest")
    {
        report.issue(
            RosterStatus::Inconsistent,
            "catalog-coverage-binding-mismatch",
            "run/coverage/snapshot/catalog",
        );
        return Ok(report);
    }
    if !report.issues.is_empty() {
        return Ok(report);
    }
    match replay::resolve(conn, &run_id, &context_root, &coverage, &receipts) {
        Ok(replay::Outcome::Complete(materials, proofs)) => {
            report.materials = materials;
            report.replayed_requests = proofs;
            report.recipe = Some("citation-id-v2/observation-v5/synthesis-v2/single-window/identity-merge/no-repair@1");
            report.status = RosterStatus::Complete;
        }
        Ok(replay::Outcome::Unsupported(code)) => {
            report.issue(RosterStatus::Unsupported, code, "versioned-input-recipe")
        }
        Err(error) => {
            if error.downcast_ref::<rusqlite::Error>().is_some() {
                return Err(error);
            }
            let code = if error.to_string() == "request-digest-mismatch" {
                "request-digest-mismatch"
            } else {
                "recipe-input-binding-invalid"
            };
            report.issue(
                RosterStatus::Inconsistent,
                code,
                "revision/accepted-plan/full-input/request-seals",
            );
        }
    }
    Ok(report)
}

fn string_at(value: &Value, pointer: &str) -> Result<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("verified receipt shape missing {pointer}"))
}

fn array_at<'a>(value: &'a Value, pointer: &str) -> Result<&'a Vec<Value>> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("recipe array missing {pointer}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!("material_roster/production-golden.json"))
            .expect("fixed TS production input")
    }

    #[test]
    fn native_replay_matches_independent_production_request_seals() {
        let g = golden();
        for receipt in array_at(&g, "/receipts").expect("receipts") {
            let stage = string_at(receipt, "/stageExecution/stageId").expect("stage");
            let digest = if stage == prompt::OBSERVATION {
                let (digests, materials) =
                    segments::observation(&g["snapshot"], &g["plan"]["windows"][0], receipt)
                        .expect("observation recipe");
                assert_eq!(
                    materials.len(),
                    9,
                    "five spans AND four inter-block contexts"
                );
                assert_eq!(materials.iter().filter(|m| m.kind == "span").count(), 5);
                digests
            } else {
                let output = array_at(&g, "/outputs")
                    .expect("outputs")
                    .iter()
                    .find(|o| {
                        o["rootStageExecutionId"] == receipt["stageExecution"]["stageExecutionId"]
                    })
                    .expect("synthesis output");
                prompt::synthesis(
                    &string_at(output, "/clusterRef").expect("cluster"),
                    array_at(output, "/rawObservations/observations").expect("observations"),
                )
                .expect("synthesis recipe")
            };
            prompt::proof(receipt, digest)
                .expect("all three digests match preexisting independent seals");
        }
    }

    #[test]
    fn changed_body_with_identical_context_declarations_fails_request_seal() {
        let g = golden();
        let receipt = &g["receipts"][1];
        let output = &g["outputs"][0];
        let mut observations = output["rawObservations"]["observations"]
            .as_array()
            .expect("observations")
            .clone();
        observations[0]["payload"]["predicate"] = Value::String("changed text".into());
        let digest = prompt::synthesis(
            &string_at(output, "/clusterRef").expect("cluster"),
            &observations,
        )
        .expect("recipe");
        assert_eq!(digest.context_set_digest, receipt["contextSetDigest"]);
        assert_eq!(
            digest.component_contract_digest,
            receipt["componentContractDigest"]
        );
        assert_ne!(digest.final_request_digest, receipt["finalRequestDigest"]);
        assert!(prompt::proof(receipt, digest).is_err());
    }

    #[test]
    fn repair_and_unknown_contract_remain_unsupported() {
        let g = golden();
        let conn = Connection::open_in_memory().expect("empty db");
        let root = super::super::stage_provenance::VerifiedV2ContextArtifact {
            source_key: String::new(),
            revision_token: String::new(),
            cluster_ref: String::new(),
            observation_refs: vec![],
        };
        for (field, value, expected) in [
            (
                "/stageExecution/stageId",
                "narrative_structured_repair",
                "citation-repair-recipe-not-implemented",
            ),
            (
                "/componentContractDigest",
                "sha256:unknown",
                "component-recipe-unsupported",
            ),
        ] {
            let mut receipts = g["receipts"].as_array().expect("receipts").clone();
            *receipts[0].pointer_mut(field).expect("field") = Value::String(value.into());
            match replay::resolve(&conn, "unused", &root, &Value::Null, &receipts)
                .expect("unsupported before reads")
            {
                replay::Outcome::Unsupported(code) => assert_eq!(code, expected),
                _ => panic!("must not publish materials"),
            }
        }
    }

    #[test]
    fn utf16_ranges_and_json_string_order_are_not_byte_offsets() {
        assert_eq!(
            segments::utf16_slice("a😀\n中", 1, 3).expect("astral"),
            "😀"
        );
        assert!(segments::utf16_slice("a😀", 1, 2).is_err());
        assert!(segments::utf16_slice("a", 0, 2).is_err());
    }
}
