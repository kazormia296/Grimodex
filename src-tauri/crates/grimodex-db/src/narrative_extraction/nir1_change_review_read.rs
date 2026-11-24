use std::collections::HashMap;

use anyhow::Context;
use grimodex_core::narrative_change_review::{
    diff_evidence_records, identity_objects_from_bundle, EvidenceChange as CoreEvidenceChange,
    EvidenceChangeKind, EvidenceRecord,
};
use grimodex_core::narrative_identity_diff::{diff_identity_objects, IdentityDiffChange};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::inbox_read_model::list_consumer_freshness;
use super::nir1_entity_relation::{
    read_nir1_entity_relation_revision, read_nir1_entity_relation_revision_current_for_revision,
    Nir1EntityRelationRevision, Nir1EntityRelationRevisionCurrentRead,
    Nir1EntityRelationRevisionRead, NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
    NIR1_ENTITY_RELATION_SET_KIND,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1ChangeReviewRead {
    pub revision_id: String,
    pub previous_revision_id: Option<String>,
    pub review_status: String,
    pub objects: Vec<ObjectChange>,
    pub freshness: Nir1ChangeReviewFreshness,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectChange {
    pub identity: String,
    pub change: String,
    pub evidence: Vec<EvidenceChange>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceChange {
    pub source_ref: String,
    pub quote: String,
    pub change: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1ChangeReviewFreshness {
    pub edge_count: usize,
    pub feed_head_sequence: i64,
    pub feed_acknowledged_through_sequence: i64,
    pub build_action: Option<String>,
}

/// Finds the immediately preceding approved current Revision in this typed lane.
/// Same-time ties use revision ID order, matching the returned chronological key.
pub fn find_previous_approved_typed_revision_id(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
) -> anyhow::Result<Option<String>> {
    conn.query_row(
        "WITH current_revision AS (
             SELECT proposal_set.created_at, revision.id
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
            AND previous_proposal.status = 'approved'
            AND (previous_set.created_at < current_row.created_at
                 OR (previous_set.created_at = current_row.created_at
                     AND previous_revision.id < current_row.id))
          ORDER BY previous_set.created_at DESC, previous_revision.id DESC
          LIMIT 1",
        params![
            revision_id,
            project_id,
            NIR1_ENTITY_RELATION_SET_KIND,
            NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
        ],
        |row| row.get(0),
    )
    .optional()
    .context("query previous approved typed revision")
}

/// Read the current typed Revision and compare it with the previous approved one.
/// The caller must provide a read transaction, as the typed Revision reader does.
pub fn read_nir1_change_review(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
) -> anyhow::Result<Option<Nir1ChangeReviewRead>> {
    let (current, review_status) = match read_nir1_entity_relation_revision_current_for_revision(
        conn,
        project_id,
        revision_id,
    )? {
        Nir1EntityRelationRevisionCurrentRead::Draft(revision) => (*revision, "unreviewed"),
        Nir1EntityRelationRevisionCurrentRead::Available(revision) => (*revision, "approved"),
        Nir1EntityRelationRevisionCurrentRead::Unavailable { .. } => return Ok(None),
    };

    let previous_revision_id =
        find_previous_approved_typed_revision_id(conn, project_id, revision_id)?;
    let previous = match previous_revision_id.as_deref() {
        Some(previous_revision_id) => {
            match read_nir1_entity_relation_revision(conn, project_id, previous_revision_id)? {
                Nir1EntityRelationRevisionRead::Available(revision) => Some(*revision),
                Nir1EntityRelationRevisionRead::Unavailable { reason } => {
                    anyhow::bail!("previous approved typed revision is unavailable: {reason}")
                }
            }
        }
        None => None,
    };

    let current_objects = identity_objects_from_bundle(&current.bundle);
    let previous_objects = previous
        .as_ref()
        .map(|revision| identity_objects_from_bundle(&revision.bundle))
        .unwrap_or_default();
    let changes = diff_identity_objects(&previous_objects, &current_objects)?;
    let current_evidence = evidence_by_identity(&current);
    let previous_evidence = previous.as_ref().map(evidence_by_identity);
    let objects = changes
        .into_iter()
        .map(|change| {
            let before = previous_evidence
                .as_ref()
                .and_then(|evidence| evidence.get(&change.identity))
                .map(Vec::as_slice)
                .unwrap_or_default();
            let after = current_evidence
                .get(&change.identity)
                .map(Vec::as_slice)
                .unwrap_or_default();
            Ok(ObjectChange {
                identity: change.identity,
                change: identity_change_name(change.change).into(),
                evidence: diff_evidence_records(before, after)?
                    .into_iter()
                    .map(evidence_change)
                    .collect(),
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let build_action = list_consumer_freshness(conn, project_id)?
        .into_iter()
        .find(|freshness| {
            freshness.consumer_kind == "proposal-revision" && freshness.consumer_key == revision_id
        })
        .map(|freshness| freshness.build_action.as_str().to_owned());

    Ok(Some(Nir1ChangeReviewRead {
        revision_id: current.revision_id,
        previous_revision_id,
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

fn evidence_by_identity(
    revision: &Nir1EntityRelationRevision,
) -> HashMap<String, Vec<EvidenceRecord>> {
    let entities = revision.bundle.entities.iter().map(|entity| {
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
    let relations = revision
        .bundle
        .relations
        .iter()
        .map(|relation| (format!("codex-relation:{}", relation.edge_id), Vec::new()));
    entities.chain(relations).collect()
}

fn identity_change_name(change: IdentityDiffChange) -> &'static str {
    match change {
        IdentityDiffChange::Added => "added",
        IdentityDiffChange::Removed => "removed",
        IdentityDiffChange::Unchanged => "unchanged",
        IdentityDiffChange::ContentChanged => "content-changed",
    }
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
    }
}

#[cfg(test)]
mod tests {
    use super::{identity_change_name, IdentityDiffChange};
    use grimodex_core::narrative_identity_diff::{diff_identity_objects, IdentityDiffObject};
    use rusqlite::Connection;
    use serde_json::Value;

    use crate::narrative_extraction::nir1_entity_relation::tests as typed_tests;
    use crate::narrative_extraction::{
        find_previous_approved_typed_revision_id,
        narrative_extraction_create_nir1_entity_relation_revision, read_nir1_change_review,
        Nir1ChangeReviewRead,
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
    ) -> anyhow::Result<Option<Nir1ChangeReviewRead>> {
        db.with_read_transaction(|conn| {
            let before = row_counts(conn)?;
            let result = read_nir1_change_review(conn, project_id, revision_id)?;
            let after = row_counts(conn)?;
            anyhow::ensure!(
                before == after,
                "change review read changed table row counts"
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
        let initial = read_without_writes(&db, "default-project", &first_id)?
            .expect("created typed revision is available");
        assert_eq!(initial.previous_revision_id, None);
        assert_eq!(initial.review_status, "unreviewed");
        assert!(initial
            .objects
            .iter()
            .all(|object| object.change == "added"));
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
        let review = read_without_writes(&db, "default-project", &current_id)?
            .expect("created current revision is available");
        assert_eq!(
            review.previous_revision_id.as_deref(),
            Some(first_id.as_str())
        );
        assert_ne!(
            review.previous_revision_id.as_deref(),
            Some(draft_id.as_str())
        );
        assert_eq!(review.review_status, "unreviewed");
        assert_eq!(
            review
                .objects
                .iter()
                .find(|object| object.identity == "codex:nir1-bob")
                .map(|object| object.change.as_str()),
            Some("removed")
        );
        assert_eq!(
            review
                .objects
                .iter()
                .find(|object| object.identity == "codex:change-review-added")
                .map(|object| object.change.as_str()),
            Some("added")
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

        assert!(read_without_writes(&db, "different-project", &current_id)?.is_none());
        let wrong_project_lookup = db.with_read_transaction(|conn| {
            find_previous_approved_typed_revision_id(conn, "different-project", &current_id)
        })?;
        assert_eq!(wrong_project_lookup, None);
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
        assert_eq!(identity_change_name(change[0].change), "content-changed");
    }
}
