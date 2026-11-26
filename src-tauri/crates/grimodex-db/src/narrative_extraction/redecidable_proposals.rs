use std::collections::{BTreeSet, HashMap};

use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::nir1_entity_relation::NIR1_ENTITY_RELATION_PROPOSAL_KIND;
use super::repository::RemovedVia;
use super::scene_proposals::{evidence_entries, SCENE_SOURCE_PREFIX};
use super::{ChronicleBulkApproveTarget, SCENE_PROPOSALS_EVIDENCE_MAX};
use crate::Database;

/// Whether a proposal may be re-approved now.
pub(super) enum Eligibility {
    /// The latest decision is Native's removal rejection with this id.
    Eligible {
        rejection_id: String,
    },
    Skip(&'static str),
}

struct Facts {
    revision: Option<String>,
    rejected: bool,
    application: bool,
    revisions_match: bool,
    events_present: bool,
    approved: bool,
    removal_id: Option<String>,
    decision_at: Option<String>,
    via: Option<RemovedVia>,
}

fn decide(facts: Option<&Facts>, input_revision: Option<&str>) -> Eligibility {
    let Some(facts) = facts else {
        return Eligibility::Skip("proposal-not-found");
    };
    if !facts.application {
        return Eligibility::Skip("no-application");
    }
    if !facts.revisions_match
        || facts.revision.is_none()
        || facts.revision.as_deref() != input_revision
    {
        return Eligibility::Skip("revision-changed");
    }
    if facts.approved {
        return Eligibility::Skip("already-approved");
    }
    let Some(id) = facts.removal_id.as_ref().filter(|_| facts.rejected) else {
        return Eligibility::Skip("not-removal-rejection");
    };
    if !facts.events_present {
        return Eligibility::Skip("event-missing");
    }
    Eligibility::Eligible {
        rejection_id: id.clone(),
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Reapproval {
    pub available: bool,
    pub reason: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedecideStatus {
    pub rejected_by: Option<&'static str>,
    pub(crate) removed_via: Option<RemovedVia>,
    pub rejected_at: Option<String>,
    pub reapproval: Reapproval,
}

impl Facts {
    fn status(&self) -> RedecideStatus {
        let reason = match decide(Some(self), self.revision.as_deref()) {
            Eligibility::Eligible { .. } => None,
            Eligibility::Skip(reason) => Some(reason),
        };
        let removal = self.removal_id.as_ref();
        RedecideStatus {
            rejected_by: removal.map(|_| "event-removed"),
            removed_via: removal.and(self.via),
            rejected_at: removal.and(self.decision_at.clone()),
            reapproval: Reapproval {
                available: reason.is_none(),
                reason,
            },
        }
    }
}

// A page supplies proposal ids. The project-wide read starts from the live
// Applications themselves, since a proposal without one cannot be eligible.
const FACTS_SQL: &str = "
WITH live AS MATERIALIZED (
    SELECT p.id, min(a.revision_id IS p.current_revision_id) AS revisions_match,
           min(e.id IS NOT NULL) AS events_present
      FROM narrative_proposal_applications a
      CROSS JOIN narrative_apply_commits c ON c.id=a.commit_id
      CROSS JOIN narrative_proposal_sets s ON s.id=c.proposal_set_id AND s.run_id=c.run_id AND s.project_id=c.project_id
      CROSS JOIN narrative_extraction_runs run ON run.id=s.run_id AND run.project_id=s.project_id
      CROSS JOIN narrative_proposals p ON p.id=a.proposal_id AND p.proposal_set_id=s.id
      LEFT JOIN events e ON e.id=a.applied_entity_id AND e.project_id=c.project_id
     WHERE c.project_id=?1 AND p.kind<>?3 AND a.application_kind='normal' AND a.applied_entity_kind='event'
       AND (?2 IS NULL OR a.proposal_id IN (SELECT value FROM json_each(?2)))
       AND NOT EXISTS (SELECT 1 FROM narrative_proposal_applications compensation
                        WHERE compensation.application_kind='compensation' AND compensation.compensates_application_id=a.id)
     GROUP BY p.id
), targets(id) AS (
    SELECT value FROM json_each(?2) UNION ALL SELECT id FROM live WHERE ?2 IS NULL
)
SELECT p.id, r.id, p.status='rejected', live.id IS NOT NULL,
       coalesce(live.revisions_match,0), coalesce(live.events_present,0), d.decision IS 'approved',
       CASE WHEN d.decision='rejected' AND d.revision_id=r.id AND d.actor_kind='ai'
             AND d.actor_id='native:event-existence-sync' AND CASE WHEN json_valid(d.decision_json)
             THEN json_extract(d.decision_json,'$.cause') END IS 'event-removed' THEN d.id END,
       d.created_at, CASE WHEN json_valid(d.decision_json) THEN
           CASE WHEN json_type(d.decision_json,'$.removedVia')='text'
                THEN json_extract(d.decision_json,'$.removedVia') END END
  FROM targets
  CROSS JOIN narrative_proposals p ON p.id=targets.id
  CROSS JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id AND s.project_id=?1
  LEFT JOIN narrative_proposal_revisions r ON r.id=p.current_revision_id AND r.proposal_id=p.id
  LEFT JOIN live ON live.id=p.id
  LEFT JOIN narrative_proposal_decisions d ON d.id=(
      SELECT id FROM narrative_proposal_decisions WHERE proposal_id=p.id ORDER BY created_at DESC,id DESC LIMIT 1)
 ORDER BY p.id";

fn visit_facts(
    conn: &Connection,
    project: &str,
    ids: Option<&[&str]>,
    mut visit: impl FnMut(String, Facts),
) -> anyhow::Result<()> {
    let ids = ids.map(serde_json::to_string).transpose()?;
    let mut stmt = conn.prepare_cached(FACTS_SQL)?;
    let mut rows = stmt.query(params![project, ids, NIR1_ENTITY_RELATION_PROPOSAL_KIND])?;
    while let Some(row) = rows.next()? {
        let via: Option<String> = row.get(9)?;
        let facts = Facts {
            revision: row.get(1)?,
            rejected: row.get(2)?,
            application: row.get(3)?,
            revisions_match: row.get(4)?,
            events_present: row.get(5)?,
            approved: row.get(6)?,
            removal_id: row.get(7)?,
            decision_at: row.get(8)?,
            via: via.and_then(|v| serde_json::from_value(Value::String(v)).ok()),
        };
        visit(row.get(0)?, facts);
    }
    Ok(())
}

pub(super) fn page_statuses(
    conn: &Connection,
    project: &str,
    ids: &[&str],
) -> anyhow::Result<HashMap<String, RedecideStatus>> {
    let mut statuses = HashMap::new();
    if !ids.is_empty() {
        visit_facts(conn, project, Some(ids), |id, facts| {
            statuses.insert(id, facts.status());
        })?;
    }
    Ok(statuses)
}

pub(super) fn judge_reapproval(
    conn: &Connection,
    project: &str,
    target: &ChronicleBulkApproveTarget,
) -> anyhow::Result<Eligibility> {
    let mut facts = None;
    visit_facts(conn, project, Some(&[&target.proposal_id]), |_, row| {
        facts = Some(row)
    })?;
    Ok(decide(facts.as_ref(), Some(&target.revision_id)))
}

pub(super) fn attach_redecide_status(
    conn: &Connection,
    project: &str,
    proposals: &mut [Value],
) -> Result<()> {
    let ids = proposals
        .iter()
        .map(|p| p["proposalId"].as_str().context("proposal missing id"))
        .collect::<Result<Vec<_>>>()?;
    let mut statuses = page_statuses(conn, project, &ids)?;
    for proposal in proposals {
        let id = proposal["proposalId"]
            .as_str()
            .context("proposal missing id")?;
        let status = statuses
            .remove(id)
            .context("missing review proposal facts")?;
        let Value::Object(fields) = serde_json::to_value(status)? else {
            anyhow::bail!("invalid redecision fields");
        };
        proposal
            .as_object_mut()
            .context("invalid review proposal")?
            .extend(fields);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListRedecidableProposalsPayload {
    pub project_id: String,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedecidableProposalItem {
    pub proposal_id: String,
    pub revision_id: String,
    pub title: Option<String>,
    pub evidence_scene_ids: Vec<String>,
    pub evidence_scene_ids_truncated: bool,
    pub rejected_at: String,
    pub(crate) removed_via: Option<RemovedVia>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedecidableProposalPage {
    pub items: Vec<RedecidableProposalItem>,
    pub total: usize,
    pub next_cursor: Option<String>,
    pub limit: u32,
}

pub fn narrative_extraction_list_redecidable_proposals(
    db: &Database,
    payload: ListRedecidableProposalsPayload,
) -> Result<RedecidableProposalPage> {
    for id in std::iter::once(&payload.project_id).chain(payload.cursor.iter()) {
        ensure!(
            !id.is_empty() && id.trim() == id && id.len() <= 256,
            "NEX_REDECIDABLE_PROPOSALS_INPUT_INVALID: invalid projectId or cursor"
        );
    }
    let limit = payload.limit.unwrap_or(20).min(50);
    ensure!(
        limit > 0,
        "NEX_REDECIDABLE_PROPOSALS_INPUT_INVALID: limit must be positive"
    );
    db.with_read_transaction(|conn| {
        let mut total = 0;
        let mut page = Vec::with_capacity(limit as usize + 1);
        visit_facts(conn, &payload.project_id, None, |id, facts| {
            if let Eligibility::Eligible { .. } = decide(Some(&facts), facts.revision.as_deref()) {
                total += 1;
                if page.len() <= limit as usize
                    && payload.cursor.as_ref().is_none_or(|cursor| &id > cursor)
                {
                    page.push((id, facts));
                }
            }
        })?;
        let next_cursor = if page.len() > limit as usize {
            page.pop();
            page.last().map(|(id, _)| id.clone())
        } else {
            None
        };
        let mut revision = conn.prepare_cached(
            "SELECT payload_json, reconciliation_envelope_json FROM narrative_proposal_revisions
              WHERE id=?1 AND proposal_id=?2",
        )?;
        let mut items = Vec::with_capacity(page.len());
        for (proposal_id, facts) in page {
            let revision_id = facts
                .revision
                .context("eligible proposal missing revision")?;
            let (payload, envelope): (String, Option<String>) = revision
                .query_row(params![revision_id, proposal_id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?;
            let payload: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
            let envelope: Value = envelope
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or(Value::Null);
            let scene_ids: BTreeSet<_> = evidence_entries(&envelope)
                .iter()
                .filter_map(|entry| {
                    entry["sourceKey"]
                        .as_str()?
                        .strip_prefix(SCENE_SOURCE_PREFIX)
                })
                .collect();
            items.push(RedecidableProposalItem {
                proposal_id,
                revision_id,
                title: payload["title"].as_str().map(str::to_owned),
                evidence_scene_ids_truncated: scene_ids.len() > SCENE_PROPOSALS_EVIDENCE_MAX,
                evidence_scene_ids: scene_ids
                    .into_iter()
                    .take(SCENE_PROPOSALS_EVIDENCE_MAX)
                    .map(str::to_owned)
                    .collect(),
                rejected_at: facts
                    .decision_at
                    .context("eligible proposal missing rejection time")?,
                removed_via: facts.via,
            });
        }
        Ok(RedecidableProposalPage {
            items,
            total,
            next_cursor,
            limit,
        })
    })
    .map_err(|error| anyhow::anyhow!("NEX_REDECIDABLE_PROPOSALS_READ_FAILED: {error}"))
}
