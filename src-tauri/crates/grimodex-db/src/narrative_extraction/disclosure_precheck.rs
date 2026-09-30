//! Opt-in read-only material authority mapping. No disclosure policy is assumed.
//! Input membership, query-axis resolution and candidate Scope are separate.
pub(super) mod scene_axis;
use super::{
    material_roster::{inspect_material_roster, RosterStatus},
    project_scope_authority::load_live_project_scope_authority,
};
use anyhow::Result;
use rusqlite::Connection;
use serde_json::{json, Value};

/// Caller holds one coherent read transaction. This consumes the unchanged
/// verified membership resolver and reuses Native live project authority.
/// Mapping version names the provenance shape, NOT an approved disclosure rule.
pub fn inspect_disclosure_precheck(
    conn: &Connection,
    project: &str,
    revision: &str,
    s2: &str,
) -> Result<Value> {
    let roster = inspect_material_roster(conn, project, revision)?;
    if roster.status != RosterStatus::Complete {
        return Ok(
            json!({"diagnosticOnly":true,"status":"membership-unavailable", "membership":roster,
            "admission":"not-evaluated","materials":[]}),
        );
    }
    let source_key = format!("project:scope-authority:{project}");
    let authority = load_live_project_scope_authority(conn, project, &source_key)?;
    let mode: String = conn.query_row(
        "SELECT phase_resolution_mode FROM projects WHERE id=?1",
        [project],
        |r| r.get(0),
    )?;
    let axis = scene_axis::resolve(&authority, &mode, s2)?;
    let envelope: String = conn.query_row(
        "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id=?1",
        [revision],
        |r| r.get(0),
    )?;
    let envelope: Value = serde_json::from_str(&envelope)?;
    let scope = &envelope["assertion"]["scope"];
    let unresolved = scope
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(_, v)| v["kind"] == "unresolved")
                .map(|(k, _)| k.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut materials = vec![];
    let mut missing_source = false;
    let mut same_scene = false;
    for (index, material) in roster.materials.iter().enumerate() {
        let mapping = authority
            .mappings
            .iter()
            .find(|m| m.source_key == material.source_key);
        missing_source |= mapping.is_none();
        same_scene |= mapping.is_some_and(|m| m.scene_ref == format!("scene:{s2}"));
        let current_revision = match mapping {
            Some(_) => {
                let source_revision = super::source_revision::resolve_source_revision(
                    conn,
                    project,
                    roster.run_id.as_deref().unwrap_or_default(),
                    "scene-body",
                    &material.source_key,
                )?;
                Some(source_revision.revision_token)
            }
            None => None,
        };
        materials.push(json!({
            "materialId":format!("{}:{}:{}",revision,material.request_execution_id,index),
            "material":material,"sourceKind":"scene-body","currentSourceRevision":current_revision,
            "authority":{
                "contractId":"narrative-project-scope-authority-revision/1",
                "source":authority.source,"digests":authority.digests,"mapping":mapping
            },
            "disclosurePolicyRef":null,
            "unresolvedItems":if mapping.is_some() {vec!["scene-body-material-disclosure-policy"]} else {vec!["live-source-authority-missing","scene-body-material-disclosure-policy"]}
        }));
    }
    let status = if axis.axis_used.is_none() {
        "query-scene-missing"
    } else if same_scene {
        "distinct-s2-required"
    } else if missing_source {
        "material-authority-unavailable"
    } else {
        "disclosure-policy-required"
    };
    // No conversion to V1 or assertion-scope copy onto source materials occurs.
    // Even resolved query axes do not change unresolved candidate constraints.
    Ok(
        json!({"diagnosticOnly":true,"mappingVersion":"nir1.material-authority-mapping/1",
        "status":status,"admission":"not-evaluated","membershipStatus":"complete",
        "revisionId":revision,"querySceneId":s2,"materials":materials,
        "queryAxis":{"recipe":"adr-002/scene-anchor/no-phases/no-graph@1","phaseResolutionMode":mode,"resolution":axis},
        "candidateScope":{"version":scope["schemaVersion"],"unresolvedAxes":unresolved},
        "notEvaluated":["per-material-disclosure","scope-v2-historical-reference","canonical-freshness","eligibility-writer-coverage","search-eligibility"]}),
    )
}

/// Scene-anchor axis only. This does not construct a full disclosure context.
/// Useful before a disclosure-eligible revision exists in a new fixture.
pub fn inspect_query_axis(conn: &Connection, project: &str, s2: &str) -> Result<Value> {
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
    let axis = scene_axis::resolve(&authority, &mode, s2)?;
    Ok(json!({"diagnosticOnly":true,"admission":"not-evaluated",
        "recipe":"adr-002/scene-anchor/no-phases/no-graph@1",
        "phaseResolutionMode":mode,"resolution":axis,"authority":authority}))
}
