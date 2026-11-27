use std::collections::BTreeSet;

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use super::bulk_approval::{failure_code, run_approval_targets, Outcome};
pub(super) use super::redecidable_proposals::{judge_reapproval, Eligibility};
use super::repository::{append_event_existence_decisions_in_tx, EventExistenceChange};
use super::{with_immediate_transaction, ChronicleBulkApproveTarget, BULK_APPROVE_MAX_TARGETS};
use crate::narrative_runtime_policy::{
    require_narrative_extraction_allowed, NARRATIVE_ENGINE_DISABLED,
};
use crate::Database;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReapproveAppliedProposalsPayload {
    pub project_id: String,
    pub targets: Vec<ChronicleBulkApproveTarget>,
}

impl ReapproveAppliedProposalsPayload {
    fn validate(&self) -> anyhow::Result<()> {
        let valid_id = |id: &str| !id.is_empty() && id.trim() == id;
        anyhow::ensure!(
            valid_id(&self.project_id),
            "NEX_REAPPROVE_INVALID: invalid projectId"
        );
        anyhow::ensure!(
            (1..=BULK_APPROVE_MAX_TARGETS).contains(&self.targets.len()),
            "NEX_REAPPROVE_INVALID: targets must hold 1..={BULK_APPROVE_MAX_TARGETS} entries"
        );
        let mut seen = BTreeSet::new();
        for target in &self.targets {
            anyhow::ensure!(
                valid_id(&target.proposal_id) && valid_id(&target.revision_id),
                "NEX_REAPPROVE_INVALID: invalid target id"
            );
            anyhow::ensure!(
                seen.insert(&target.proposal_id),
                "NEX_REAPPROVE_INVALID: duplicate proposalId"
            );
        }
        Ok(())
    }
}

fn reapprove_one(
    conn: &Connection,
    project: &str,
    target: &ChronicleBulkApproveTarget,
) -> anyhow::Result<Outcome<&'static str>> {
    require_narrative_extraction_allowed(conn)?;
    if let Eligibility::Skip(reason) = judge_reapproval(conn, project, target)? {
        return Ok(Outcome::Skipped(vec![reason]));
    }
    let decision_id = Uuid::new_v4().to_string();
    append_event_existence_decisions_in_tx(
        conn,
        project,
        EventExistenceChange::Reapproved {
            target,
            decision_id: &decision_id,
        },
    )?;
    Ok(Outcome::Approved {
        proposal_id: target.proposal_id.clone(),
        revision_id: target.revision_id.clone(),
        decision_id,
    })
}

pub fn narrative_extraction_reapprove_applied_proposals(
    db: &Database,
    payload: ReapproveAppliedProposalsPayload,
    should_stop: &mut dyn FnMut() -> bool,
) -> anyhow::Result<Value> {
    payload.validate()?;
    run_approval_targets(
        &payload.targets,
        should_stop,
        &mut |target| {
            db.with_conn_mut(|conn| {
                Ok(with_immediate_transaction(conn, |conn| {
                    reapprove_one(conn, &payload.project_id, target)
                }))
            })
        },
        |error| {
            if error.to_string().split(':').next() == Some(NARRATIVE_ENGINE_DISABLED) {
                NARRATIVE_ENGINE_DISABLED.to_owned()
            } else {
                failure_code(error, "NEX_REAPPROVE_FAILED")
            }
        },
    )
}
