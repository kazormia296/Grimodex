//! Approved read-only diagnostic policy. Never grants product search eligibility.
use super::{
    material_roster::{inspect_material_roster, RosterStatus},
    project_scope_authority::load_live_project_scope_authority,
    reconciliation_envelope::{
        ensure_v2_proposal_payload_digest, validate_reconciliation_envelope,
    },
    repository::ensure_v2_proposal_evidence_binding,
};
use anyhow::Result;
use grimodex_core::{canonical_json_digest, narrative_ir::validate_narrative_scope_v2};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

pub const POLICY_REF: &str = "nir1.scene-body-reader-history/1";
const OBSERVATION_DIGEST: &str =
    "sha256:c41c79347c0e96851e06e14de2c05d1519d1ad0e2a4f2e5ae886e94eb28e1c22";
const SYNTHESIS_DIGEST: &str =
    "sha256:5e63b1a1c4c3a3aba76689732e3876deae5ea230f15d961d74932e16b3b876ff";
fn decision(status: &str, reason: &str) -> Value {
    json!({"status":status,"reason":reason})
}

// These are the two contracts whose instruction AND output shape were reviewed
// as non-story static text. Matching a name alone never confers this classification.
fn known_static_contract(stage: &str, digest: &str, contract: &Value) -> Result<bool> {
    let (id, version, expected) = match stage {
        "narrative_observation_extract" => (
            "chronicle.observation-extraction.prompt",
            "5",
            OBSERVATION_DIGEST,
        ),
        "narrative_event_synthesize" => ("chronicle.event-synthesis.prompt", "2", SYNTHESIS_DIGEST),
        _ => return Ok(false),
    };
    Ok(contract["contractId"] == id
        && contract["contractVersion"] == version
        && digest == expected
        && canonical_json_digest(
            &json!({"schemaVersion":1,"contextSetVersion":"chronicle.context-set/1","stageId":stage,"componentContract":contract}),
        )? == expected)
}

fn material_admission(i: &Value) -> Value {
    if i["project"] != i["authorityProject"] {
        return decision("denied", "project-authority-mismatch");
    }
    if i["queryRank"].as_u64().is_none() {
        return decision("denied", "query-scene-missing");
    }
    if i["axis"] != "reading" {
        return decision("unsupported", "story-axis-unsupported");
    }
    let Some(materials) = i["materials"].as_array().filter(|m| !m.is_empty()) else {
        return decision("denied", "material-authority-unavailable");
    };
    for m in materials {
        let (Some(rank), Some(_)) = (m["readingRank"].as_u64(), m["sceneRef"].as_str()) else {
            return decision("denied", "material-authority-unavailable");
        };
        if m["sceneRef"] == i["querySceneRef"] {
            return decision("denied", "distinct-s2-required");
        }
        if Some(rank) >= i["queryRank"].as_u64() {
            return decision("denied", "source-not-before-query");
        }
    }
    decision("admitted", "materials-reader-history")
}
fn candidate_admission(i: &Value) -> Value {
    if i["bindingValid"] != true {
        return decision("denied", "candidate-binding-invalid");
    }
    if i["approved"] != true {
        return decision("denied", "revision-not-approved");
    }
    if i["secret"] != false {
        return decision("denied", "candidate-secret");
    }
    let scope = &i["scope"];
    if scope
        .as_object()
        .is_some_and(|s| s.values().any(|v| v["kind"] == "unresolved"))
    {
        return decision("denied", "candidate-scope-unresolved");
    }
    if validate_narrative_scope_v2(scope).is_err() {
        return decision("unsupported", "candidate-scope-unsupported");
    }
    if i["axis"] != "reading" {
        return decision("unsupported", "story-axis-unsupported");
    }
    if scope["scene"]["kind"] != "exact" {
        return decision("unsupported", "candidate-scope-unsupported");
    }
    for axis in [
        "timeline",
        "worldline",
        "viewpoint",
        "knowledgeHolder",
        "audience",
        "narrativeLayer",
        "storyTime",
        "readingOrder",
    ] {
        if scope[axis]["kind"] == "any" {
            continue;
        }
        if axis == "audience" && scope[axis]["kind"] == "exact" && scope[axis]["ref"] == "reader" {
            continue;
        }
        return decision("unsupported", "candidate-scope-unsupported");
    }
    let Some(materials) = i["materials"].as_array() else {
        return decision("denied", "candidate-scene-evidence-mismatch");
    };
    let Some(evidence) = i["evidenceSources"].as_array().filter(|e| !e.is_empty()) else {
        return decision("denied", "candidate-scene-evidence-mismatch");
    };
    for source in evidence {
        let Some(m) = materials.iter().find(|m| m["sourceKey"] == *source) else {
            return decision("denied", "candidate-scene-evidence-mismatch");
        };
        if m["sceneRef"] != scope["scene"]["ref"] {
            return decision("denied", "candidate-scene-evidence-mismatch");
        }
        if m["sceneRef"] == i["querySceneRef"] {
            return decision("denied", "distinct-s2-required");
        }
        if m["readingRank"].as_u64().is_none()
            || i["queryRank"].as_u64().is_none()
            || m["readingRank"].as_u64() >= i["queryRank"].as_u64()
        {
            return decision("denied", "source-not-before-query");
        }
    }
    decision("admitted", "scope-v2-historical-reference")
}
fn evaluate(i: &Value) -> Value {
    json!({"materialAdmission":material_admission(i),"candidateAdmission":candidate_admission(i)})
}

/// Caller owns a single read transaction. All queries are read-only; no current
/// token equality is required or interpreted as canonical Freshness.
pub fn inspect_diagnostic_disclosure(
    conn: &Connection,
    project: &str,
    revision: &str,
    s2: &str,
) -> Result<Value> {
    let roster = inspect_material_roster(conn, project, revision)?;
    let mut report = json!({"diagnosticOnly":true,"policyRef":POLICY_REF,"admission":"not-evaluated",
        "revisionId":revision,"querySceneId":s2,"projectId":project,"membershipStatus":roster.status,
        "materialAdmission":decision("not-evaluated","membership-unavailable"),
        "candidateAdmission":decision("not-evaluated","membership-unavailable"),
        "candidateBindingAdmission":decision("not-evaluated","membership-unavailable"),
        "staticContractAdmission":decision("not-evaluated","membership-unavailable"),
        "searchEligibility":"not-evaluated","notEvaluated":["canonical-freshness","eligibility-writer-coverage","index-state","runtime-activation"]});
    if roster.status != RosterStatus::Complete {
        report["reason"] = json!("membership-unavailable");
        report["membership"] = serde_json::to_value(roster)?;
        return Ok(report);
    }
    let contracts: Value = serde_json::from_str(include_str!("material_roster/contracts.json"))?;
    let mut classified = Vec::new();
    let mut all_static = true;
    for receipt in &roster.verified_receipts {
        let c = &contracts[&receipt.stage_id];
        let known =
            known_static_contract(&receipt.stage_id, &receipt.component_contract_digest, c)?;
        all_static &= known;
        classified.push(json!({"stageId":receipt.stage_id,"executionId":receipt.execution_id,"contractId":c["contractId"],"contractVersion":c["contractVersion"],"componentContractDigest":receipt.component_contract_digest,"classification":if known {"reviewed-non-story-static-input"} else {"unclassified"}}));
    }
    all_static &= !classified.is_empty();
    report["staticContracts"] = json!(classified);
    report["staticContractAdmission"] = if all_static {
        decision("admitted", "reviewed-static-contracts")
    } else {
        decision("unsupported", "static-contract-unclassified")
    };
    let authority = load_live_project_scope_authority(
        conn,
        project,
        &format!("project:scope-authority:{project}"),
    )?;
    let mode: String = conn.query_row(
        "SELECT phase_resolution_mode FROM projects WHERE id=?1",
        [project],
        |r| r.get(0),
    )?;
    let axis = super::disclosure_precheck::scene_axis::resolve(&authority, &mode, s2)?;
    let target = authority
        .mappings
        .iter()
        .find(|m| m.scene_ref == format!("scene:{s2}"));
    let materials=roster.materials.iter().map(|m| {
        let mapping=authority.mappings.iter().find(|a|a.source_key==m.source_key);
        json!({"material":m,"sourceKey":m.source_key,"sceneRef":mapping.map(|a|&a.scene_ref),"readingRank":mapping.map(|a|a.reading_rank),"mapping":mapping})
    }).collect::<Vec<_>>();
    let (proposal,current,status,kind,payload,envelope):(String,Option<String>,String,String,String,String)=conn.query_row(
        "SELECT p.id,p.current_revision_id,p.status,p.kind,r.payload_json,r.reconciliation_envelope_json FROM narrative_proposal_revisions r JOIN narrative_proposals p ON p.id=r.proposal_id WHERE r.id=?1",[revision],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    let payload: Value = serde_json::from_str(&payload)?;
    let envelope: Value = serde_json::from_str(&envelope)?;
    let run = roster
        .run_id
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("complete roster requires run"))?;
    let binding = (|| -> Result<()> {
        anyhow::ensure!(
            validate_reconciliation_envelope(conn, project, run, Some(&envelope))?.is_some(),
            "validated envelope required"
        );
        grimodex_core::narrative_ir::validate_chronicle_scene_event_proposal_payload(&payload)?;
        ensure_v2_proposal_payload_digest(&envelope, &payload)?;
        ensure_v2_proposal_evidence_binding(&envelope, &payload)?;
        anyhow::ensure!(
            envelope["projectionBinding"]["proposalKind"] == kind,
            "proposal kind mismatch"
        );
        Ok(())
    })();
    if let Err(ref error) = binding {
        if error.downcast_ref::<rusqlite::Error>().is_some() {
            return Err(binding.expect_err("checked failure"));
        }
    }
    let latest:Option<(String,String,String,String,Option<String>)>=conn.query_row(
        "SELECT id,revision_id,decision,actor_kind,authority_scope FROM narrative_proposal_decisions WHERE proposal_id=?1 ORDER BY created_at DESC,id DESC LIMIT 1",[&proposal],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let expected_authority = format!("project/{project}/proposal/{proposal}/revision/{revision}");
    let approved = current.as_deref() == Some(revision)
        && status == "approved"
        && latest.as_ref().is_some_and(|(_, r, d, a, s)| {
            r == revision
                && d == "approved"
                && a == "human"
                && s.as_deref() == Some(&expected_authority)
        });
    report["candidateBindingAdmission"] = if binding.is_err() {
        decision("denied", "candidate-binding-invalid")
    } else if !approved {
        decision("denied", "revision-not-approved")
    } else {
        decision("admitted", "current-human-approved-revision")
    };
    let evidence = envelope["effectiveMaterialBasis"]["evidenceSet"]
        .as_array()
        .map(|e| e.iter().map(|e| e["sourceKey"].clone()).collect::<Vec<_>>())
        .unwrap_or_default();
    let input = json!({"project":project,"authorityProject":authority.project_id,"axis":axis.axis_used,"querySceneRef":format!("scene:{s2}"),"queryRank":target.map(|t|t.reading_rank),"materials":materials,"scope":envelope["assertion"]["scope"],"evidenceSources":evidence,"secret":payload["disclosure"]["secret"],"bindingValid":binding.is_ok(),"approved":approved});
    let evaluated = evaluate(&input);
    report["materialAdmission"] = evaluated["materialAdmission"].clone();
    report["candidateAdmission"] = evaluated["candidateAdmission"].clone();
    report["materials"] = input["materials"].clone();
    report["authority"] = serde_json::to_value(&authority)?;
    report["queryAxis"] = json!({"phaseResolutionMode":mode,"resolution":axis,"recipe":"adr-002/scene-anchor/no-phases/no-graph@1"});
    report["candidateScope"] = json!({"scope":input["scope"],"scopeDigest":envelope["assertionDigests"]["scopeDigest"],"evidenceSources":evidence});
    report["approval"] = json!({"proposalId":proposal,"currentRevisionId":current,"status":status,"latestDecisionId":latest.as_ref().map(|d|&d.0)});
    let decisions = [
        "materialAdmission",
        "candidateAdmission",
        "candidateBindingAdmission",
        "staticContractAdmission",
    ];
    report["admission"] = json!(
        if decisions.iter().all(|k| report[*k]["status"] == "admitted") {
            "admitted"
        } else if decisions.iter().any(|k| report[*k]["status"] == "denied") {
            "denied"
        } else {
            "unsupported"
        }
    );
    report["membership"] = serde_json::to_value(roster)?;
    Ok(report)
}
#[cfg(test)]
mod tests;
