use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use super::bulk_approval::{failure_code, run_approval_targets, Outcome};
use super::nir1_entity_relation::NIR1_ENTITY_RELATION_PROPOSAL_KIND;
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

/// Whether a proposal may be re-approved now.
pub(super) enum Eligibility {
    /// The latest decision is Native's removal rejection with this id.
    Eligible {
        rejection_id: String,
    },
    Skip(&'static str),
}

/// Judges one target from the database state alone. The command uses it to
/// report a reason, and the decision writer calls it again before it writes, so
/// no caller can append an approval the database does not support.
pub(super) fn judge_reapproval(
    conn: &Connection,
    project: &str,
    target: &ChronicleBulkApproveTarget,
) -> anyhow::Result<Eligibility> {
    let skipped = |reason| Ok(Eligibility::Skip(reason));
    let proposal = conn.query_row(
        "SELECT r.id, p.status FROM narrative_proposals p
           JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id
           LEFT JOIN narrative_proposal_revisions r ON r.proposal_id=p.id AND r.id=p.current_revision_id
          WHERE p.id=?1 AND s.project_id=?2",
        params![target.proposal_id, project],
        |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)),
    ).optional()?;
    let Some((revision, status)) = proposal else {
        return skipped("proposal-not-found");
    };
    // Match the removal writer's live Applications. Every applied revision and event must match.
    let (count, revisions_match, events_present): (i64, bool, bool) = conn.query_row(
        "SELECT count(*), coalesce(min(a.revision_id IS ?3), 0), coalesce(min(e.id IS NOT NULL), 0)
           FROM narrative_proposal_applications a
           JOIN narrative_apply_commits c ON c.id=a.commit_id
           JOIN narrative_proposal_sets s ON s.id=c.proposal_set_id AND s.run_id=c.run_id AND s.project_id=c.project_id
           JOIN narrative_extraction_runs run ON run.id=s.run_id AND run.project_id=s.project_id
           JOIN narrative_proposals p ON p.id=a.proposal_id AND p.proposal_set_id=s.id
           LEFT JOIN events e ON e.id=a.applied_entity_id AND e.project_id=c.project_id
          WHERE c.project_id=?1 AND a.proposal_id=?2 AND p.kind<>?4
            AND a.application_kind='normal' AND a.applied_entity_kind='event'
            AND NOT EXISTS (SELECT 1 FROM narrative_proposal_applications compensation
                             WHERE compensation.application_kind='compensation'
                               AND compensation.compensates_application_id=a.id)",
        params![project, target.proposal_id, target.revision_id, NIR1_ENTITY_RELATION_PROPOSAL_KIND],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if count == 0 {
        return skipped("no-application");
    }
    if !revisions_match || revision.as_deref() != Some(target.revision_id.as_str()) {
        return skipped("revision-changed");
    }
    let latest = conn.query_row(
        "SELECT id, decision, revision_id IS ?2 AND actor_kind IS 'ai'
                AND actor_id IS 'native:event-existence-sync'
                AND CASE WHEN json_valid(decision_json) THEN json_extract(decision_json, '$.cause') END IS 'event-removed'
           FROM narrative_proposal_decisions WHERE proposal_id=?1 ORDER BY created_at DESC, id DESC LIMIT 1",
        params![target.proposal_id, target.revision_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?)),
    ).optional()?;
    let Some((rejection_id, decision, removal)) = latest else {
        return skipped("not-removal-rejection");
    };
    if decision == "approved" {
        return skipped("already-approved");
    }
    if status != "rejected" || decision != "rejected" || !removal {
        return skipped("not-removal-rejection");
    }
    if !events_present {
        return skipped("event-missing");
    }
    Ok(Eligibility::Eligible { rejection_id })
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
