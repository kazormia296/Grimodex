//! Pending Feed completeness is bound to the existing Native transaction seal.
//! Audit-only canonical sequence gaps are legitimate and are not reconstructed.
use std::collections::{BTreeMap, HashSet};

use anyhow::Result;
use rusqlite::{params, Connection};

use super::super::change_feed::{
    payload_digest, AppendNarrativeChangeTransactionInput, NarrativeChangeEventInput,
    NarrativeChangeEventRecord,
};

pub(super) fn input(event: &NarrativeChangeEventRecord) -> NarrativeChangeEventInput {
    NarrativeChangeEventInput {
        object_key: event.object_key.clone(),
        change_kind: event.change_kind.clone(),
        mutation_kind: event.mutation_kind.clone(),
        before_version: event.before_version,
        before_digest: event.before_digest.clone(),
        after_version: event.after_version,
        after_digest: event.after_digest.clone(),
        changed_paths: event.changed_paths.clone(),
        text_impact: event.text_impact.clone(),
        structural_impact: event.structural_impact.clone(),
    }
}

/// `events` contains every event in whole canonical sequences. Check that no
/// Native Feed transaction or member event disappeared from that bounded page.
pub(super) fn verify(
    conn: &Connection,
    project: &str,
    after: i64,
    through: i64,
    events: &[NarrativeChangeEventRecord],
) -> Result<bool> {
    let mut grouped = BTreeMap::<&str, Vec<&NarrativeChangeEventRecord>>::new();
    for event in events {
        grouped
            .entry(&event.transaction_id)
            .or_default()
            .push(event);
    }
    let mut statement = conn.prepare(
        "SELECT t.id,t.request_id,t.source_domain,t.source_change_event_uid,t.source_change_event_sequence,
          t.cause_kind,t.origin,t.original_transaction_id,t.commit_id,t.journal_id,t.undo_journal_id,
          t.application_ids_json,t.payload_digest,t.created_at,c.sequence,c.op_type
         FROM narrative_change_transactions t LEFT JOIN change_events c
          ON c.project_id=t.project_id AND c.event_uid=t.source_change_event_uid
         WHERE t.project_id=?1 AND t.source_change_event_sequence>?2 AND t.source_change_event_sequence<=?3
         ORDER BY t.source_change_event_sequence,t.id",
    )?;
    let mut rows = statement.query(params![project, after, through])?;
    let mut verified = HashSet::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let Some(group) = grouped.get(id.as_str()) else {
            return Ok(false);
        };
        let Some(first) = group.first() else {
            return Ok(false);
        };
        let request_id: String = row.get(1)?;
        let source_domain: String = row.get(2)?;
        let source_uid: String = row.get(3)?;
        let sequence: i64 = row.get(4)?;
        let cause: String = row.get(5)?;
        let origin: String = row.get(6)?;
        let original: Option<String> = row.get(7)?;
        let commit: Option<String> = row.get(8)?;
        let journal: Option<String> = row.get(9)?;
        let undo: Option<String> = row.get(10)?;
        let apps: String = row.get(11)?;
        let seal: String = row.get(12)?;
        let created: String = row.get(13)?;
        let canonical_sequence: Option<i64> = row.get(14)?;
        let canonical_operation: Option<String> = row.get(15)?;
        let application_ids: Vec<String> = match serde_json::from_str(&apps) {
            Ok(ids) => ids,
            Err(_) => return Ok(false),
        };
        if canonical_sequence != Some(sequence)
            || canonical_operation.as_deref() != Some(source_domain.as_str())
            || cause != first.cause_kind.as_str()
            || origin != first.origin.as_str()
        {
            return Ok(false);
        }
        for (ordinal, event) in group.iter().enumerate() {
            if event.event_ordinal != ordinal as i64
                || event.project_id != project
                || event.canonical_sequence != sequence
                || event.canonical_change_event_uid != source_uid
                || event.cause_kind != first.cause_kind
                || event.origin != first.origin
                || event.original_transaction_id != original
                || event.commit_id != commit
                || event.journal_id != journal
                || event.undo_journal_id != undo
                || event.application_ids != application_ids
                || event.occurred_at != created
            {
                return Ok(false);
            }
        }
        let expected = payload_digest(&AppendNarrativeChangeTransactionInput {
            project_id: project.into(),
            request_id,
            source_domain,
            source_change_event_uid: source_uid,
            cause_kind: first.cause_kind,
            origin: first.origin,
            original_transaction_id: original,
            commit_id: commit,
            journal_id: journal,
            undo_journal_id: undo,
            application_ids,
            occurred_at: created,
            events: group.iter().map(|event| input(event)).collect(),
        })?;
        if expected != seal {
            return Ok(false);
        }
        verified.insert(id);
    }
    Ok(verified.len() == grouped.len())
}
