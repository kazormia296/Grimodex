use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub(super) struct CurrentRevision {
    pub proposal_id: String,
    pub decision_id: String,
    pub envelope_digest: String,
    pub envelope_json: String,
    pub payload_json: String,
}

pub(super) fn read(
    conn: &Connection,
    project: &str,
    revision: &str,
) -> Result<Option<CurrentRevision>> {
    let row = conn
        .query_row(
            "SELECT p.id,p.current_revision_id,p.status,r.reconciliation_envelope_digest,
                r.reconciliation_envelope_json,r.payload_json
         FROM narrative_proposal_revisions r JOIN narrative_proposals p ON p.id=r.proposal_id
         JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id
         WHERE r.id=?1 AND s.project_id=?2",
            params![revision, project],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((proposal, current, status, Some(digest), Some(envelope), payload)) = row else {
        return Ok(None);
    };
    if current.as_deref() != Some(revision) || status != "approved" {
        return Ok(None);
    }
    let latest = conn
        .query_row(
            "SELECT id,revision_id,decision,actor_kind,actor_id,authority_scope
         FROM narrative_proposal_decisions WHERE proposal_id=?1
         ORDER BY created_at DESC,id DESC LIMIT 1",
            [&proposal],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((decision_id, decided_revision, decision, actor_kind, actor_id, scope)) = latest
    else {
        return Ok(None);
    };
    let expected = format!("project/{project}/proposal/{proposal}/revision/{revision}");
    if decided_revision != revision
        || decision != "approved"
        || actor_kind != "human"
        || actor_id != "electron:human-review"
        || scope.as_deref() != Some(&expected)
    {
        return Ok(None);
    }
    Ok(Some(CurrentRevision {
        proposal_id: proposal,
        decision_id,
        envelope_digest: digest,
        envelope_json: envelope,
        payload_json: payload,
    }))
}
