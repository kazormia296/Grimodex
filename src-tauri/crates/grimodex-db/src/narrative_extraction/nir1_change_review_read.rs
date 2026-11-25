use std::collections::{HashMap, HashSet};

use anyhow::Context;
use grimodex_core::narrative_change_review::{
    diff_evidence_records, identity_objects_from_bundle, EvidenceChange as CoreEvidenceChange,
    EvidenceChangeKind, EvidenceRecord,
};
use grimodex_core::narrative_identity_diff::{
    diff_identity_objects, IdentityDiffChange, IdentityDiffObject,
};
use grimodex_core::narrative_nir1::EntityRelationBundle;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::nir1_entity_relation::{
    read_nir1_entity_relation_revision_current_for_revision,
    read_nir1_entity_relation_revision_historical, Nir1EntityRelationRevisionCurrentRead,
    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH, NIR1_ENTITY_RELATION_SET_KIND,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1ChangeReviewRead {
    pub revision_id: String,
    pub previous_revision_ids: Vec<String>,
    pub review_status: String,
    pub objects: Vec<ObjectChange>,
    pub freshness: Nir1ChangeReviewFreshness,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectChange {
    pub identity: String,
    pub change: Nir1ChangeReviewObjectChange,
    pub evidence: Vec<EvidenceChange>,
    pub evidence_withheld: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Nir1ChangeReviewObjectChange {
    Added,
    Removed,
    Unchanged,
    ContentChanged,
    Unresolved,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", content = "result", rename_all = "kebab-case")]
pub enum Nir1ChangeReviewResult {
    Available(Nir1ChangeReviewRead),
    Unavailable { reason: &'static str },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceChange {
    pub source_ref: String,
    pub quote: String,
    pub change: String,
    pub start_utf16: usize,
    pub end_utf16: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1ChangeReviewFreshness {
    pub edge_count: usize,
    pub feed_head_sequence: i64,
    pub feed_acknowledged_through_sequence: i64,
    pub build_action: Option<String>,
}

// shortcut: 64 prior revisions, raise only with an updated bounded-lookup contract.
pub const CHANGE_REVIEW_PRIOR_SCAN_MAX: usize = 64;

/// Read the current typed Revision and compare each identity with its prior approval.
/// The caller must provide a read transaction, as the typed Revision reader does.
pub fn read_nir1_change_review(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
) -> anyhow::Result<Nir1ChangeReviewResult> {
    read_nir1_change_review_with_prior_scan_max(
        conn,
        project_id,
        revision_id,
        CHANGE_REVIEW_PRIOR_SCAN_MAX,
    )
}

fn read_nir1_change_review_with_prior_scan_max(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
    prior_scan_max: usize,
) -> anyhow::Result<Nir1ChangeReviewResult> {
    let (current, review_status) = match read_nir1_entity_relation_revision_current_for_revision(
        conn,
        project_id,
        revision_id,
    )? {
        Nir1EntityRelationRevisionCurrentRead::Draft(revision) => (*revision, "unreviewed"),
        Nir1EntityRelationRevisionCurrentRead::Available(revision) => (*revision, "approved"),
        Nir1EntityRelationRevisionCurrentRead::Unavailable { .. } => {
            return Ok(Nir1ChangeReviewResult::Unavailable {
                reason: "current-revision-unavailable",
            })
        }
    };

    let current_objects = identity_objects_from_bundle(&current.bundle);
    let Some(previous) = read_previous_identity_objects(
        conn,
        project_id,
        revision_id,
        &current.canonical_freshness.semantic_epoch_id,
        &current_objects,
        prior_scan_max,
    )?
    else {
        return Ok(Nir1ChangeReviewResult::Unavailable {
            reason: "previous-revision-invalid",
        });
    };

    let previous_objects: Vec<_> = current_objects
        .iter()
        .filter_map(|object| previous.by_identity.get(&object.identity).cloned())
        .collect();
    let changes = diff_identity_objects(&previous_objects, &current_objects)?;
    let current_evidence = evidence_by_identity(&current.bundle);
    let mut objects = Vec::with_capacity(changes.len());
    for change in changes {
        anyhow::ensure!(
            change.change != IdentityDiffChange::Removed,
            "change review must only contain current bundle identities"
        );
        let before = previous
            .evidence_by_identity
            .get(&change.identity)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let after = current_evidence
            .get(&change.identity)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let (evidence, evidence_withheld) =
            evidence_changes_for_object(conn, project_id, &change.identity, before, after)?;
        objects.push(ObjectChange {
            change: if previous.unresolved_identities.contains(&change.identity) {
                Nir1ChangeReviewObjectChange::Unresolved
            } else {
                identity_change_kind(change.change)
            },
            identity: change.identity,
            evidence,
            evidence_withheld,
        });
    }
    let build_action: Option<String> = conn
        .query_row(
            "SELECT build_action
               FROM narrative_consumer_freshness
              WHERE project_id = ?1
                AND consumer_kind = 'proposal-revision'
                AND consumer_key = ?2",
            params![project_id, revision_id],
            |row| row.get(0),
        )
        .optional()
        .context("query proposal revision freshness")?;

    Ok(Nir1ChangeReviewResult::Available(Nir1ChangeReviewRead {
        revision_id: current.revision_id,
        previous_revision_ids: previous.revision_ids,
        review_status: review_status.into(),
        objects,
        freshness: Nir1ChangeReviewFreshness {
            edge_count: current.canonical_freshness.edge_count,
            feed_head_sequence: current.canonical_freshness.feed_head_sequence,
            feed_acknowledged_through_sequence: current
                .canonical_freshness
                .feed_acknowledged_through_sequence,
            build_action,
        },
    }))
}

struct PreviousIdentityReads {
    by_identity: HashMap<String, IdentityDiffObject>,
    evidence_by_identity: HashMap<String, Vec<EvidenceRecord>>,
    revision_ids: Vec<String>,
    unresolved_identities: HashSet<String>,
}

fn read_previous_identity_objects(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
    semantic_epoch_id: &str,
    current_objects: &[IdentityDiffObject],
    prior_scan_max: usize,
) -> anyhow::Result<Option<PreviousIdentityReads>> {
    let mut previous_revision_ids = if current_objects.is_empty() {
        Vec::new()
    } else {
        let mut statement = conn.prepare(
            "WITH current_revision AS (
                 SELECT proposal_set.created_at, revision.id, extraction_run.semantic_epoch_id
                   FROM narrative_proposal_revisions revision
                   JOIN narrative_proposals proposal
                     ON proposal.id = revision.proposal_id
                   JOIN narrative_proposal_sets proposal_set
                     ON proposal_set.id = proposal.proposal_set_id
                   JOIN narrative_extraction_runs extraction_run
                     ON extraction_run.id = proposal_set.run_id
                    AND extraction_run.project_id = proposal_set.project_id
                  WHERE revision.id = ?1
                    AND proposal.current_revision_id = revision.id
                    AND proposal_set.project_id = ?2
                    AND proposal_set.set_kind = ?3
                    AND extraction_run.surface_path_id = ?4
             )
             SELECT previous_revision.id
               FROM current_revision current_row
               CROSS JOIN narrative_proposal_revisions previous_revision
               JOIN narrative_proposals previous_proposal
                 ON previous_proposal.id = previous_revision.proposal_id
                AND previous_proposal.current_revision_id = previous_revision.id
               JOIN narrative_proposal_sets previous_set
                 ON previous_set.id = previous_proposal.proposal_set_id
               JOIN narrative_extraction_runs previous_run
                 ON previous_run.id = previous_set.run_id
                AND previous_run.project_id = previous_set.project_id
              WHERE previous_set.project_id = ?2
                AND previous_set.set_kind = ?3
                AND previous_run.surface_path_id = ?4
                AND previous_run.semantic_epoch_id = current_row.semantic_epoch_id
                AND current_row.semantic_epoch_id = ?5
                AND previous_proposal.status = 'approved'
                AND (previous_set.created_at < current_row.created_at
                     OR (previous_set.created_at = current_row.created_at
                         AND previous_revision.id < current_row.id))
              ORDER BY previous_set.created_at DESC, previous_revision.id DESC
              LIMIT ?6",
        )?;
        let revision_ids = statement
            .query_map(
                params![
                    revision_id,
                    project_id,
                    NIR1_ENTITY_RELATION_SET_KIND,
                    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
                    semantic_epoch_id,
                    prior_scan_max.saturating_add(1).min(i64::MAX as usize) as i64,
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        revision_ids
    };
    let has_more_revisions = previous_revision_ids.len() > prior_scan_max;
    previous_revision_ids.truncate(prior_scan_max);

    let mut unresolved_identities: HashSet<_> = current_objects
        .iter()
        .map(|object| object.identity.clone())
        .collect();
    let mut by_identity = HashMap::new();
    let mut evidence_reads = HashMap::new();
    let mut revision_ids = Vec::new();
    for previous_revision_id in previous_revision_ids {
        if unresolved_identities.is_empty() {
            break;
        }
        let Some(previous) =
            read_nir1_entity_relation_revision_historical(conn, project_id, &previous_revision_id)?
        else {
            return Ok(None);
        };
        let previous_objects = identity_objects_from_bundle(&previous.bundle);
        let previous_evidence = evidence_by_identity(&previous.bundle);
        let mut used_revision = false;
        for object in previous_objects {
            if unresolved_identities.remove(&object.identity) {
                if let Some(evidence) = previous_evidence.get(&object.identity) {
                    evidence_reads.insert(object.identity.clone(), evidence.clone());
                }
                by_identity.insert(object.identity.clone(), object);
                used_revision = true;
            }
        }
        if used_revision {
            revision_ids.push(previous_revision_id);
        }
    }

    if !has_more_revisions {
        unresolved_identities.clear();
    }

    Ok(Some(PreviousIdentityReads {
        by_identity,
        evidence_by_identity: evidence_reads,
        revision_ids,
        unresolved_identities,
    }))
}

fn evidence_by_identity(bundle: &EntityRelationBundle) -> HashMap<String, Vec<EvidenceRecord>> {
    let entities = bundle.entities.iter().map(|entity| {
        (
            format!("codex:{}", entity.entity_id),
            entity
                .evidence
                .iter()
                .map(|evidence| EvidenceRecord {
                    source_ref: evidence.source_ref.clone(),
                    quote: evidence.quote.clone(),
                    start_utf16: evidence.start_utf16,
                    end_utf16: evidence.end_utf16,
                })
                .collect(),
        )
    });
    // Relations store evidence IDs only; the typed bundle contains no Evidence bodies to compare.
    let relations = bundle
        .relations
        .iter()
        .map(|relation| (format!("codex-relation:{}", relation.edge_id), Vec::new()));
    entities.chain(relations).collect()
}

fn identity_change_kind(change: IdentityDiffChange) -> Nir1ChangeReviewObjectChange {
    match change {
        IdentityDiffChange::Added => Nir1ChangeReviewObjectChange::Added,
        IdentityDiffChange::Removed => Nir1ChangeReviewObjectChange::Removed,
        IdentityDiffChange::Unchanged => Nir1ChangeReviewObjectChange::Unchanged,
        IdentityDiffChange::ContentChanged => Nir1ChangeReviewObjectChange::ContentChanged,
    }
}

fn evidence_changes_for_object(
    conn: &Connection,
    project_id: &str,
    identity: &str,
    previous: &[EvidenceRecord],
    current: &[EvidenceRecord],
) -> anyhow::Result<(Vec<EvidenceChange>, bool)> {
    let evidence_withheld = evidence_is_withheld(conn, project_id, identity)?;
    let evidence = if evidence_withheld {
        Vec::new()
    } else {
        diff_evidence_records(previous, current)?
            .into_iter()
            .map(evidence_change)
            .collect()
    };
    Ok((evidence, evidence_withheld))
}

fn evidence_is_withheld(
    conn: &Connection,
    project_id: &str,
    identity: &str,
) -> anyhow::Result<bool> {
    if let Some(entity_id) = identity.strip_prefix("codex:") {
        let context_mode: Option<String> = conn
            .query_row(
                "SELECT context_mode FROM codex_entries WHERE project_id = ?1 AND id = ?2",
                params![project_id, entity_id],
                |row| row.get(0),
            )
            .optional()?;
        return Ok(context_mode
            .as_deref()
            .is_none_or(|mode| matches!(mode, "hidden" | "suppress")));
    }
    if let Some(relation_id) = identity.strip_prefix("codex-relation:") {
        let visible: bool = conn.query_row(
            "SELECT EXISTS (
                 SELECT 1
                   FROM codex_relations relation
                   JOIN codex_entries source
                     ON source.id = relation.from_codex_id
                    AND source.project_id = relation.project_id
                   JOIN codex_entries target
                     ON target.id = relation.to_codex_id
                    AND target.project_id = relation.project_id
                  WHERE relation.project_id = ?1 AND relation.id = ?2
                    AND source.context_mode NOT IN ('hidden', 'suppress')
                    AND target.context_mode NOT IN ('hidden', 'suppress')
             )",
            params![project_id, relation_id],
            |row| row.get(0),
        )?;
        return Ok(!visible);
    }
    Ok(true)
}

fn evidence_change(change: CoreEvidenceChange) -> EvidenceChange {
    EvidenceChange {
        source_ref: change.source_ref,
        quote: change.quote,
        change: match change.change {
            EvidenceChangeKind::Unchanged => "unchanged",
            EvidenceChangeKind::Relocated => "relocated",
            EvidenceChangeKind::Lost => "lost",
            EvidenceChangeKind::Gained => "gained",
        }
        .into(),
        start_utf16: change.start_utf16,
        end_utf16: change.end_utf16,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        evidence_changes_for_object, identity_change_kind,
        read_nir1_change_review_with_prior_scan_max, IdentityDiffChange,
        Nir1ChangeReviewObjectChange, Nir1ChangeReviewResult,
    };
    use grimodex_core::narrative_identity_diff::{diff_identity_objects, IdentityDiffObject};
    use rusqlite::{params, Connection};
    use serde_json::Value;

    use crate::narrative_extraction::narrative_extraction_create_nir1_entity_relation_revision;
    use crate::narrative_extraction::nir1_entity_relation::{
        read_nir1_entity_relation_revision_historical, tests as typed_tests,
        Nir1EntityRelationHistoricalRevision,
    };
    use crate::test_support::fresh_migrated_memory;
    use crate::Database;
    use grimodex_core::narrative_nir1::{EntityInput, EvidenceInput};

    fn extra_entity(
        entity_id: &str,
        name: &str,
        scope: grimodex_core::narrative_nir1::ScopeBinding,
        evidence_id: &str,
        quote: &str,
        start_utf16: usize,
    ) -> EntityInput {
        EntityInput {
            entity_id: entity_id.into(),
            entity_type: "character".into(),
            label: name.into(),
            source_token: format!("codex:{entity_id}@2026-09-12T00:00:00Z"),
            scope,
            evidence: vec![EvidenceInput {
                evidence_id: evidence_id.into(),
                source_ref: format!("codex:{entity_id}"),
                quote: quote.into(),
                start_utf16,
                end_utf16: start_utf16 + quote.encode_utf16().count(),
            }],
        }
    }

    fn create_on_run(
        db: &Database,
        run_id: &str,
        proposal_key: &str,
        mut bundle: grimodex_core::narrative_nir1::EntityRelationBundle,
    ) -> anyhow::Result<Value> {
        typed_tests::create_typed_run(db, run_id)?;
        let mut request = typed_tests::request_for_run(db, run_id, proposal_key);
        bundle.revision_id = "renderer-must-not-own-this".into();
        request.bundle = bundle;
        narrative_extraction_create_nir1_entity_relation_revision(db, request)
    }

    fn row_counts(conn: &Connection) -> anyhow::Result<Vec<(String, i64)>> {
        let mut statement = conn.prepare(
            "SELECT name FROM sqlite_schema
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
              ORDER BY name",
        )?;
        let tables = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        tables
            .into_iter()
            .map(|table| {
                let count = conn.query_row(
                    &format!("SELECT COUNT(*) FROM \"{}\"", table.replace('"', "\"\"")),
                    [],
                    |row| row.get(0),
                )?;
                Ok((table, count))
            })
            .collect()
    }

    fn read_without_writes(
        db: &Database,
        project_id: &str,
        revision_id: &str,
    ) -> anyhow::Result<Nir1ChangeReviewResult> {
        db.with_read_transaction(|conn| {
            let before = row_counts(conn)?;
            let result = super::read_nir1_change_review(conn, project_id, revision_id)?;
            let after = row_counts(conn)?;
            anyhow::ensure!(
                before == after,
                "change review read changed table row counts"
            );
            Ok(result)
        })
    }

    fn set_proposal_created_at(
        db: &Database,
        revision_id: &str,
        created_at: &str,
    ) -> anyhow::Result<()> {
        db.with_conn(|conn| {
            let updated = conn.execute(
                "UPDATE narrative_proposal_sets
                    SET created_at = ?2
                  WHERE id = (
                    SELECT proposal.proposal_set_id
                      FROM narrative_proposal_revisions revision
                      JOIN narrative_proposals proposal ON proposal.id = revision.proposal_id
                     WHERE revision.id = ?1
                  )",
                params![revision_id, created_at],
            )?;
            anyhow::ensure!(updated == 1, "proposal set for revision was not found");
            Ok(())
        })
    }

    fn create_approved_on_run(
        db: &Database,
        run_id: &str,
        proposal_key: &str,
        bundle: grimodex_core::narrative_nir1::EntityRelationBundle,
        created_at: &str,
    ) -> anyhow::Result<Value> {
        let created = create_on_run(db, run_id, proposal_key, bundle)?;
        let revision_id = id(&created, "revisionId")?;
        set_proposal_created_at(db, &revision_id, created_at)?;
        typed_tests::approve_typed_revision(db, run_id, &created)?;
        Ok(created)
    }

    fn read_historical_without_writes(
        db: &Database,
        project_id: &str,
        revision_id: &str,
    ) -> anyhow::Result<Option<Nir1EntityRelationHistoricalRevision>> {
        db.with_read_transaction(|conn| {
            let before = row_counts(conn)?;
            let result =
                read_nir1_entity_relation_revision_historical(conn, project_id, revision_id)?;
            let after = row_counts(conn)?;
            anyhow::ensure!(
                before == after,
                "historical revision read changed table row counts"
            );
            Ok(result)
        })
    }

    fn id(value: &Value, field: &str) -> anyhow::Result<String> {
        value[field]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow::anyhow!("created revision missing {field}"))
    }

    #[test]
    fn typed_change_review_reads_first_and_previous_approved_revision() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        typed_tests::seed_run_and_catalog(&db)?;
        db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE codex_entries SET summary = 'Alice Alice'
                  WHERE id = 'nir1-alice' AND project_id = 'default-project'",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                 VALUES ('change-review-lost', 'default-project', 'character', 'Delta',
                         'Delta clue', '2026-09-12T00:00:00Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                 VALUES ('change-review-added', 'default-project', 'character', 'Carol',
                         'Carol', '2026-09-12T00:00:00Z')",
                [],
            )?;
            Ok(())
        })?;

        let mut first_request = typed_tests::request(&db);
        let scope = first_request.bundle.entities[0].scope.clone();
        first_request.bundle.entities.push(extra_entity(
            "change-review-lost",
            "Delta",
            scope.clone(),
            "evidence-delta",
            "Delta",
            0,
        ));
        let previous_bundle = first_request.bundle.clone();
        let first = narrative_extraction_create_nir1_entity_relation_revision(&db, first_request)?;
        let first_id = id(&first, "revisionId")?;
        let Nir1ChangeReviewResult::Available(initial) =
            read_without_writes(&db, "default-project", &first_id)?
        else {
            panic!("created typed revision is available");
        };
        assert!(initial.previous_revision_ids.is_empty());
        assert_eq!(initial.review_status, "unreviewed");
        assert!(initial
            .objects
            .iter()
            .all(|object| object.change == Nir1ChangeReviewObjectChange::Added));
        assert!(initial
            .objects
            .iter()
            .find(|object| object.identity == "codex-relation:nir1-edge")
            .expect("relation included")
            .evidence
            .is_empty());

        typed_tests::approve_typed_revision(&db, "nir1-run", &first)?;
        let draft = create_on_run(
            &db,
            "change-review-unreviewed-run",
            "change-review:unreviewed",
            previous_bundle.clone(),
        )?;
        let draft_id = id(&draft, "revisionId")?;

        let mut current_bundle = previous_bundle;
        current_bundle
            .entities
            .retain(|entity| entity.entity_id != "nir1-bob");
        current_bundle.relations.clear();
        let alice = current_bundle
            .entities
            .iter_mut()
            .find(|entity| entity.entity_id == "nir1-alice")
            .expect("Alice from first revision");
        alice.evidence[0].start_utf16 = 6;
        alice.evidence[0].end_utf16 = 11;
        let delta = current_bundle
            .entities
            .iter_mut()
            .find(|entity| entity.entity_id == "change-review-lost")
            .expect("Delta from first revision");
        delta.evidence = vec![EvidenceInput {
            evidence_id: "evidence-clue".into(),
            source_ref: "codex:change-review-lost".into(),
            quote: "clue".into(),
            start_utf16: 6,
            end_utf16: 10,
        }];
        current_bundle.entities.push(extra_entity(
            "change-review-added",
            "Carol",
            scope,
            "evidence-carol",
            "Carol",
            0,
        ));
        let current = create_on_run(
            &db,
            "change-review-current-run",
            "change-review:current",
            current_bundle,
        )?;
        let current_id = id(&current, "revisionId")?;
        let Nir1ChangeReviewResult::Available(review) =
            read_without_writes(&db, "default-project", &current_id)?
        else {
            panic!("created current revision is available");
        };
        assert_eq!(review.previous_revision_ids, vec![first_id.clone()]);
        assert_ne!(review.previous_revision_ids, vec![draft_id]);
        assert_eq!(review.review_status, "unreviewed");
        assert!(!review
            .objects
            .iter()
            .any(|object| object.identity == "codex:nir1-bob"));
        assert_eq!(
            review
                .objects
                .iter()
                .find(|object| object.identity == "codex:change-review-added")
                .map(|object| object.change),
            Some(Nir1ChangeReviewObjectChange::Added)
        );
        assert_eq!(
            review
                .objects
                .iter()
                .find(|object| object.identity == "codex:nir1-alice")
                .expect("Alice change")
                .evidence[0]
                .change,
            "relocated"
        );
        let lost = review
            .objects
            .iter()
            .find(|object| object.identity == "codex:change-review-lost")
            .expect("Delta change");
        assert!(lost
            .evidence
            .iter()
            .any(|evidence| { evidence.quote == "Delta" && evidence.change == "lost" }));

        assert!(matches!(
            read_without_writes(&db, "different-project", &current_id)?,
            Nir1ChangeReviewResult::Unavailable {
                reason: "current-revision-unavailable"
            }
        ));
        Ok(())
    }

    #[test]
    fn historical_reader_requires_project_approval_and_bound_payload() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        typed_tests::seed_run_and_catalog(&db)?;
        let created = narrative_extraction_create_nir1_entity_relation_revision(
            &db,
            typed_tests::request(&db),
        )?;
        let revision_id = id(&created, "revisionId")?;

        assert!(read_historical_without_writes(&db, "default-project", &revision_id)?.is_none());
        typed_tests::approve_typed_revision(&db, "nir1-run", &created)?;
        assert!(read_historical_without_writes(&db, "other-project", &revision_id)?.is_none());
        assert!(read_historical_without_writes(&db, "default-project", &revision_id)?.is_some());

        db.with_conn_mut(|conn| {
            let payload: String = conn.query_row(
                "SELECT payload_json FROM narrative_proposal_revisions WHERE id = ?1",
                params![revision_id],
                |row| row.get(0),
            )?;
            let mut payload: Value = serde_json::from_str(&payload)?;
            payload["revisionId"] = Value::String("wrong-revision".into());
            conn.execute(
                "UPDATE narrative_proposal_revisions SET payload_json = ?2 WHERE id = ?1",
                params![revision_id, serde_json::to_string(&payload)?],
            )?;
            Ok(())
        })?;
        assert!(read_historical_without_writes(&db, "default-project", &revision_id)?.is_none());
        Ok(())
    }

    #[test]
    fn bounded_prior_scan_returns_unresolved_instead_of_guessing_added() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        typed_tests::seed_run_and_catalog(&db)?;
        let template = typed_tests::request(&db).bundle;
        create_approved_on_run(
            &db,
            "change-review-prior-old-run",
            "change-review:prior-old",
            template.clone(),
            "2026-09-15T00:00:00.000Z",
        )?;
        let mut recent_bundle = template.clone();
        recent_bundle
            .entities
            .retain(|entity| entity.entity_id == "nir1-bob");
        recent_bundle.relations.clear();
        create_approved_on_run(
            &db,
            "change-review-prior-recent-run",
            "change-review:prior-recent",
            recent_bundle,
            "2026-09-15T00:00:01.000Z",
        )?;
        let mut current_bundle = template;
        current_bundle
            .entities
            .retain(|entity| entity.entity_id == "nir1-alice");
        current_bundle.relations.clear();
        let current = create_on_run(
            &db,
            "change-review-prior-current-run",
            "change-review:prior-current",
            current_bundle,
        )?;
        let current_id = id(&current, "revisionId")?;
        set_proposal_created_at(&db, &current_id, "2026-09-15T00:00:02.000Z")?;

        let result = db.with_read_transaction(|conn| {
            read_nir1_change_review_with_prior_scan_max(conn, "default-project", &current_id, 1)
        })?;
        let Nir1ChangeReviewResult::Available(review) = result else {
            panic!("valid current revision should be available");
        };
        assert!(review.previous_revision_ids.is_empty());
        assert_eq!(review.objects[0].identity, "codex:nir1-alice");
        assert_eq!(
            review.objects[0].change,
            Nir1ChangeReviewObjectChange::Unresolved
        );
        Ok(())
    }

    #[test]
    fn invalid_latest_prior_revision_is_unavailable_without_skipping_older_history(
    ) -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        typed_tests::seed_run_and_catalog(&db)?;
        let template = typed_tests::request(&db).bundle;
        create_approved_on_run(
            &db,
            "change-review-invalid-old-run",
            "change-review:invalid-old",
            template.clone(),
            "2026-09-15T00:00:00.000Z",
        )?;
        let mut recent_bundle = template.clone();
        recent_bundle
            .entities
            .retain(|entity| entity.entity_id == "nir1-bob");
        recent_bundle.relations.clear();
        let recent = create_approved_on_run(
            &db,
            "change-review-invalid-recent-run",
            "change-review:invalid-recent",
            recent_bundle,
            "2026-09-15T00:00:01.000Z",
        )?;
        let recent_id = id(&recent, "revisionId")?;
        db.with_conn(|conn| {
            let payload: String = conn.query_row(
                "SELECT payload_json FROM narrative_proposal_revisions WHERE id = ?1",
                params![recent_id],
                |row| row.get(0),
            )?;
            let mut payload: Value = serde_json::from_str(&payload)?;
            payload["revisionId"] = Value::String("invalid-prior".into());
            conn.execute(
                "UPDATE narrative_proposal_revisions SET payload_json = ?2 WHERE id = ?1",
                params![recent_id, serde_json::to_string(&payload)?],
            )?;
            Ok(())
        })?;

        let mut current_bundle = template;
        current_bundle
            .entities
            .retain(|entity| entity.entity_id == "nir1-alice");
        current_bundle.relations.clear();
        let current = create_on_run(
            &db,
            "change-review-invalid-current-run",
            "change-review:invalid-current",
            current_bundle,
        )?;
        let current_id = id(&current, "revisionId")?;
        set_proposal_created_at(&db, &current_id, "2026-09-15T00:00:02.000Z")?;
        assert!(matches!(
            read_without_writes(&db, "default-project", &current_id)?,
            Nir1ChangeReviewResult::Unavailable {
                reason: "previous-revision-invalid"
            }
        ));
        Ok(())
    }

    #[test]
    fn first_review_after_epoch_advance_ignores_approved_old_epoch() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        typed_tests::seed_run_and_catalog(&db)?;
        let template = typed_tests::request(&db).bundle;
        create_approved_on_run(
            &db,
            "change-review-old-epoch-run",
            "change-review:old-epoch",
            template.clone(),
            "2026-09-15T00:00:00.000Z",
        )?;
        db.with_conn(|conn| {
            super::super::semantic_epoch::create_epoch_in_tx(
                conn,
                "default-project",
                "restore",
                None,
            )?;
            Ok(())
        })?;
        let current = create_on_run(
            &db,
            "change-review-new-epoch-run",
            "change-review:new-epoch",
            template,
        )?;
        let current_id = id(&current, "revisionId")?;
        set_proposal_created_at(&db, &current_id, "2026-09-15T00:00:02.000Z")?;

        let Nir1ChangeReviewResult::Available(review) =
            read_without_writes(&db, "default-project", &current_id)?
        else {
            panic!("first current-epoch revision should be available");
        };
        assert!(review.previous_revision_ids.is_empty());
        assert!(review
            .objects
            .iter()
            .all(|object| object.change == Nir1ChangeReviewObjectChange::Added));
        Ok(())
    }

    #[test]
    fn hidden_items_and_relations_with_hidden_endpoints_withhold_evidence() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        typed_tests::seed_run_and_catalog(&db)?;
        let created = narrative_extraction_create_nir1_entity_relation_revision(
            &db,
            typed_tests::request(&db),
        )?;
        let revision_id = id(&created, "revisionId")?;
        typed_tests::approve_typed_revision(&db, "nir1-run", &created)?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE codex_entries SET context_mode = 'hidden'
                  WHERE id = 'nir1-alice' AND project_id = 'default-project'",
                [],
            )?;
            Ok(())
        })?;
        assert!(read_historical_without_writes(&db, "default-project", &revision_id)?.is_some());

        let evidence = [grimodex_core::narrative_change_review::EvidenceRecord {
            source_ref: "codex:nir1-alice".into(),
            quote: "hidden quote".into(),
            start_utf16: 0,
            end_utf16: 12,
        }];
        for identity in [
            "codex:nir1-alice",
            "codex:missing",
            "codex-relation:nir1-edge",
        ] {
            let (changes, withheld) = db.with_read_transaction(|conn| {
                evidence_changes_for_object(conn, "default-project", identity, &evidence, &evidence)
            })?;
            assert!(withheld, "{identity} should suppress evidence");
            assert!(changes.is_empty(), "{identity} evidence should be empty");
        }
        Ok(())
    }

    #[test]
    fn source_token_changes_map_to_content_changed() {
        let previous = [IdentityDiffObject {
            identity: "codex:character".into(),
            content_token: "before".into(),
        }];
        let current = [IdentityDiffObject {
            identity: "codex:character".into(),
            content_token: "after".into(),
        }];
        let change = diff_identity_objects(&previous, &current).expect("valid identities");
        assert_eq!(change[0].change, IdentityDiffChange::ContentChanged);
        assert_eq!(
            identity_change_kind(change[0].change),
            Nir1ChangeReviewObjectChange::ContentChanged
        );
    }
}
