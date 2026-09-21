//! Consumer-scoped, read-only revision qualification. Canonical Freshness is
//! independent of approval, disclosure, the Index and scheduler liveness.
pub(super) mod freshness;
pub(in crate::narrative_extraction) mod pending;
mod pending_seals;

use anyhow::{ensure, Result};
use rusqlite::Connection;

use super::material_membership::{read_revision_material_membership, MaterialMembershipRead};
use super::source_revision::ValidationContext;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RevisionFreshnessReason {
    MembershipUnavailable,
    CanonicalAuthorityUnavailable,
    CurrentEpochUnavailable,
    CanonicalRowUnavailable,
    CanonicalRowInvalid,
    StoredStateNotFresh,
    EdgeStateUnavailable,
    EdgeStateInvalid,
    DeclarationUnavailable,
    DependencyDigestMismatch,
    PublisherInvalid,
    CurrentSourceUnavailable,
    CurrentSourceNotFresh,
    PendingRelevantChange,
    PendingGlobalChange,
    PendingUnknown,
}

#[derive(Debug)]
pub enum RevisionFreshnessRead {
    Fresh(RevisionFreshnessSnapshot),
    Unavailable { reason: RevisionFreshnessReason },
}

/// All fields refer to the caller's one SQLite read snapshot. This carries no
/// heartbeat and is not proof that a scheduler will process a future change.
#[derive(Debug)]
// The private field restricts construction to the verification owner,
// including within this crate; #[non_exhaustive] would only restrict outsiders.
#[allow(clippy::manual_non_exhaustive)]
pub struct RevisionFreshnessSnapshot {
    pub revision_id: String,
    pub semantic_epoch_id: String,
    pub dependency_set_digest: String,
    pub declaration_set_id: String,
    pub declaration_set_digest: String,
    pub last_evaluated_run_id: Option<String>,
    pub edge_count: usize,
    pub feed_acknowledged_through_sequence: i64,
    pub feed_head_sequence: i64,
    _verified: (),
}

fn unavailable(reason: RevisionFreshnessReason) -> RevisionFreshnessRead {
    RevisionFreshnessRead::Unavailable { reason }
}

fn is_storage_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<rusqlite::Error>().is_some()
        || error.downcast_ref::<std::io::Error>().is_some()
}

/// Read a proposal revision's canonical state, including its complete sealed
/// material/dependency binding, current Source observations and unacknowledged
/// Feed. A historical revision may be fresh; this does not make it current or
/// Human-approved. The retrieval reader applies those independent constraints.
pub fn read_revision_canonical_freshness(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
) -> Result<RevisionFreshnessRead> {
    ensure!(
        !conn.is_autocommit(),
        "revision Freshness requires a read transaction"
    );
    ensure!(
        !project_id.trim().is_empty() && !revision_id.trim().is_empty(),
        "nonempty identity required"
    );
    let membership = match read_revision_material_membership(conn, project_id, revision_id)? {
        MaterialMembershipRead::Complete(membership) => membership,
        MaterialMembershipRead::Unavailable { .. } => {
            return Ok(unavailable(RevisionFreshnessReason::MembershipUnavailable))
        }
    };
    freshness::read(conn, project_id, &membership)
}

/// Foreground/maintenance entry point for callers that may traverse an
/// eligibility Source.  The context couples the same transaction to the
/// caller's stop owner; the legacy convenience reader above remains valid for
/// bounded callers that never request a whole-project eligibility roster.
#[allow(dead_code)]
pub(crate) fn read_revision_canonical_freshness_with_validation_context(
    context: &mut ValidationContext<'_, '_>,
    project_id: &str,
    revision_id: &str,
) -> Result<RevisionFreshnessRead> {
    let conn = context.connection();
    ensure!(!conn.is_autocommit(), "revision Freshness requires a read transaction");
    ensure!(
        !project_id.trim().is_empty() && !revision_id.trim().is_empty(),
        "nonempty identity required"
    );
    let membership = match read_revision_material_membership(conn, project_id, revision_id)? {
        MaterialMembershipRead::Complete(membership) => membership,
        MaterialMembershipRead::Unavailable { .. } => {
            return Ok(unavailable(RevisionFreshnessReason::MembershipUnavailable))
        }
    };
    freshness::read_with_validation_context(context, project_id, &membership)
}
