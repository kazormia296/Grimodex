//! Read-only source membership for one sealed Chronicle revision lineage.
//! This is not approval, Freshness, disclosure or search eligibility.
mod lineage;

use anyhow::{ensure, Result};
use rusqlite::Connection;
#[cfg(test)]
use std::cell::Cell;

use super::human_material_basis::{MaterialBasis, MaterialSourceBasisEntry};
use super::material_membership_root::{
    read_root_material, Material, RequestProof, RosterIssue, RosterStatus, VerifiedArtifact,
    VerifiedReceipt,
};

#[cfg(test)]
thread_local! {
    pub(crate) static MATERIAL_MEMBERSHIP_READ_COUNT: Cell<usize> = const { Cell::new(0) };
}

#[derive(Debug)]
// This transient read result owns its verified snapshot and is consumed
// immediately; keep the payload inline instead of adding a heap allocation.
#[allow(clippy::large_enum_variant)]
pub enum MaterialMembershipRead {
    Complete(RevisionMaterialMembership),
    Unavailable {
        status: RosterStatus,
        issues: Vec<RosterIssue>,
    },
}

/// Historical rows are verified without comparing their tokens to live state.
#[derive(Debug)]
pub struct VerifiedMaterialRevision {
    pub revision_id: String,
    pub envelope_digest: String,
    pub parent_revision_id: Option<String>,
}

#[derive(Debug)]
pub struct RevisionMaterialMembership {
    pub revision_id: String,
    pub root_revision_id: String,
    pub proposal_id: String,
    pub run_id: String,
    /// Root first, selected revision last. Decisions are intentionally absent.
    pub lineage: Vec<VerifiedMaterialRevision>,
    pub material_basis: MaterialBasis,
    /// Selected material controls, distinct from historical context provenance.
    pub active_scope_controls: Vec<MaterialSourceBasisEntry>,
    pub materials: Vec<Material>,
    pub replayed_requests: Vec<RequestProof>,
    pub verified_receipts: Vec<VerifiedReceipt>,
    pub verified_artifacts: Vec<VerifiedArtifact>,
}

fn unavailable(status: RosterStatus, code: &'static str) -> MaterialMembershipRead {
    MaterialMembershipRead::Unavailable {
        status,
        issues: vec![RosterIssue {
            code,
            binding: "revision/lineage/material/source-basis/d1/v1",
        }],
    }
}

/// Caller owns a coherent read transaction. Only SELECTs are used. SQL/I/O
/// errors remain errors; missing or inconsistent proof never publishes material.
/// This function never reads decisions or compares historical tokens to live
/// Source revisions. The consumer must separately evaluate the selected row's
/// current authority, approval, Freshness and disclosure constraints.
pub fn read_revision_material_membership(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
) -> Result<MaterialMembershipRead> {
    #[cfg(test)]
    MATERIAL_MEMBERSHIP_READ_COUNT.with(|count| count.set(count.get() + 1));
    ensure!(
        !conn.is_autocommit(),
        "material membership requires a read transaction"
    );
    ensure!(
        !project_id.trim().is_empty() && !revision_id.trim().is_empty(),
        "nonempty identity required"
    );
    let chain = match lineage::read(conn, project_id, revision_id) {
        Ok(Some(chain)) => chain,
        Ok(None) => return Ok(unavailable(RosterStatus::Incomplete, "revision-not-found")),
        Err(error) => {
            if error.downcast_ref::<rusqlite::Error>().is_some() {
                return Err(error);
            }
            return Ok(unavailable(
                RosterStatus::Inconsistent,
                "revision-lineage-binding-invalid",
            ));
        }
    };
    let root = &chain[0];
    let selected = &chain[chain.len() - 1];
    let replay = read_root_material(conn, project_id, &root.id)?;
    if replay.status != RosterStatus::Complete {
        return Ok(MaterialMembershipRead::Unavailable {
            status: replay.status,
            issues: replay.issues,
        });
    }
    Ok(MaterialMembershipRead::Complete(
        RevisionMaterialMembership {
            revision_id: selected.id.clone(),
            root_revision_id: root.id.clone(),
            proposal_id: selected.proposal_id.clone(),
            run_id: selected.run_id.clone(),
            lineage: chain
                .iter()
                .map(|row| VerifiedMaterialRevision {
                    revision_id: row.id.clone(),
                    envelope_digest: row.digest.clone(),
                    parent_revision_id: row.parent_id().map(str::to_owned),
                })
                .collect(),
            material_basis: selected.material.material_basis.clone(),
            active_scope_controls: selected
                .material
                .material_basis
                .source_basis
                .iter()
                .filter(|source| selected.material.material_basis.dependency_set.iter().any(|d|
                    d.role == grimodex_core::narrative_dependency::DependencyRole::ScopeResolution && d.input_ref == source.source_key))
                .cloned()
                .collect(),
            materials: replay.materials,
            replayed_requests: replay.replayed_requests,
            verified_receipts: replay.verified_receipts,
            verified_artifacts: replay.verified_artifacts,
        },
    ))
}
