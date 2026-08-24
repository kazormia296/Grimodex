//! C2B Human-derived projection materialization seam.
//!
//! The C2B activation path is intentionally a RED seam in this slice.  The
//! domain entry point is real and Native-owned, but projection currently
//! delegates to the dormant C2A writer until C2B persistence is implemented.

use anyhow::anyhow;
use serde_json::Value;

use super::human_derivation;
use super::human_material_basis::HumanMaterialDerivationKind;
use super::models::CreateHumanDerivedRevisionRequest;
use crate::Database;

pub(crate) fn create_human_derived_revision_with_c2b_projection_materialization(
    db: &Database,
    trusted_project_id: &str,
    request: CreateHumanDerivedRevisionRequest,
    derivation_kind: HumanMaterialDerivationKind,
) -> anyhow::Result<Value> {
    if derivation_kind == HumanMaterialDerivationKind::ScopeOverride {
        return Err(anyhow!(
            "NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE: Native scope authority is not available for C2B materialization"
        ));
    }

    human_derivation::create_human_derived_revision(db, trusted_project_id, request)
}
