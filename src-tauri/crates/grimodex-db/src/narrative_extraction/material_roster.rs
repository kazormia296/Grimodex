//! Opt-in diagnostic adapter. The original root-only contract is unchanged.
//! Human lineage is available only through the separate typed membership API.
use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

use super::material_membership_root::{read_root_material, Material, RequestProof};
pub use super::material_membership_root::{
    RosterIssue, RosterStatus, VerifiedArtifact, VerifiedReceipt,
};

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
    pub materials: Vec<Material>,
    pub replayed_requests: Vec<RequestProof>,
    pub issues: Vec<RosterIssue>,
}

/// Caller holds a coherent read transaction. This preserves the diagnostic's
/// existing root-only behavior, including its unsupported/inconsistent cases.
pub fn inspect_material_roster(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
) -> Result<MaterialRosterReport> {
    let root = read_root_material(conn, project_id, revision_id)?;
    Ok(MaterialRosterReport {
        diagnostic_only: true,
        status: root.status,
        revision_id: root.revision_id,
        run_id: root.run_id,
        protocol: root.protocol,
        recipe: root.recipe,
        completion_scope: "source-material-membership-only",
        verified_receipts: root.verified_receipts,
        verified_artifacts: root.verified_artifacts,
        materials: root.materials,
        replayed_requests: root.replayed_requests,
        issues: root.issues,
    })
}
