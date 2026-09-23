//! Scalar admission before the A2 reader materializes a whole typed Revision.
//! This bounds stored input bytes, not serde expansion or exact heap usage.
//! The caller separately admits project scope authority and current epoch data.
use rusqlite::{params, Connection, OptionalExtension};

use grimodex_core::narrative_nir1::MAX_GRAPH_RECORDS;

use super::super::nir1_entity_relation::{
    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH, NIR1_ENTITY_RELATION_SET_KIND,
};

const INPUT_LIMIT: &str = "NIR1_GRAPH_REVISION_INPUT_LIMIT";
const ROW_LIMIT: &str = "NIR1_GRAPH_REVISION_RECORD_LIMIT";
const DISCLOSURE_ROW_LIMIT: &str = "NIR1_GRAPH_DISCLOSURE_RECORD_LIMIT";
const INPUT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct RevisionAdmission {
    pub rows: usize,
    pub bytes: usize,
    /// The A2 scalar payload length is reused by the A3 preflight. Keeping
    /// this value avoids a second octet_length query while preserving the
    /// JSON1 entity-count query after the length gate.
    pub payload_bytes: usize,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct DisclosureAdmission {
    pub rows: usize,
    pub bytes: usize,
}

/// None is reserved for a missing or wrong-family Revision. All resource
/// failures abort the query, including ineligible or malformed candidates.
pub(super) fn preflight_revision(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    remaining_rows: usize,
    remaining_bytes: usize,
) -> anyhow::Result<Option<RevisionAdmission>> {
    let lengths: Option<(i64, i64, i64)> = conn
        .query_row(
            LENGTH_SQL,
            params![
                revision_id,
                project,
                NIR1_ENTITY_RELATION_SET_KIND,
                NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((payload, envelope, metadata)) = lengths else {
        return Ok(None);
    };
    let payload_bytes = usize::try_from(payload).map_err(|_| anyhow::anyhow!(INPUT_LIMIT))?;
    let mut bytes = 0;
    for value in [payload, envelope, metadata] {
        admit_bytes(&mut bytes, value, remaining_bytes)?;
    }
    // No JSON SQL operation occurs until both persisted documents fit.
    let counts: (i64, i64, i64) = conn.query_row(
        COUNT_SQL,
        params![
            revision_id,
            project,
            NIR1_ENTITY_RELATION_SET_KIND,
            NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH
        ],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let mut rows = 0usize;
    for value in [counts.0, counts.1, counts.2] {
        rows = rows
            .checked_add(usize::try_from(value).map_err(|_| anyhow::anyhow!(ROW_LIMIT))?)
            .filter(|value| *value <= remaining_rows)
            .ok_or_else(|| anyhow::anyhow!(ROW_LIMIT))?;
    }
    // Include persisted authorities even if A2 will later reject them. Live
    // bodies are joined from payload IDs, not potentially tampered basis IDs.
    for sql in RELATED_BYTES_SQL {
        let value = conn.query_row(sql, params![project, revision_id], |row| row.get(0))?;
        admit_bytes(&mut bytes, value, remaining_bytes)?;
    }
    Ok(Some(RevisionAdmission {
        rows,
        bytes,
        payload_bytes,
    }))
}

fn admit_bytes(total: &mut usize, value: i64, remaining: usize) -> anyhow::Result<()> {
    *total = total
        .checked_add(usize::try_from(value).map_err(|_| anyhow::anyhow!(INPUT_LIMIT))?)
        .filter(|value| *value <= remaining.min(INPUT_BYTES))
        .ok_or_else(|| anyhow::anyhow!(INPUT_LIMIT))?;
    Ok(())
}

fn admit_rows(
    total: &mut usize,
    value: i64,
    multiplier: usize,
    remaining: usize,
) -> anyhow::Result<()> {
    let value = usize::try_from(value).map_err(|_| anyhow::anyhow!(DISCLOSURE_ROW_LIMIT))?;
    let additional = value
        .checked_mul(multiplier)
        .ok_or_else(|| anyhow::anyhow!(DISCLOSURE_ROW_LIMIT))?;
    *total = total
        .checked_add(additional)
        .filter(|value| *value <= remaining.min(MAX_GRAPH_RECORDS))
        .ok_or_else(|| anyhow::anyhow!(DISCLOSURE_ROW_LIMIT))?;
    Ok(())
}

const LENGTH_SQL: &str = "SELECT COALESCE(octet_length(revision.payload_json), 0),
                    COALESCE(octet_length(revision.reconciliation_envelope_json), 0),
                    COALESCE(octet_length(proposal_set.id), 0) +
                    COALESCE(octet_length(proposal_set.run_id), 0) +
                    COALESCE(octet_length(proposal.id), 0) +
                    COALESCE(octet_length(proposal.current_revision_id), 0) +
                    COALESCE(octet_length(proposal.status), 0) +
                    COALESCE(octet_length(revision.origin_kind), 0) +
                    COALESCE(octet_length(revision.reconciliation_envelope_digest), 0) +
                    COALESCE(octet_length(revision.created_at), 0) +
                    COALESCE((SELECT SUM(COALESCE(octet_length(d.id), 0) + COALESCE(octet_length(d.revision_id), 0) + COALESCE(octet_length(d.decision), 0) + COALESCE(octet_length(d.decision_json), 0) + COALESCE(octet_length(d.created_at), 0) + COALESCE(octet_length(d.created_by), 0) + COALESCE(octet_length(d.actor_kind), 0) + COALESCE(octet_length(d.actor_id), 0) + COALESCE(octet_length(d.authority_scope), 0) + COALESCE(octet_length(d.override_field_paths_json), 0))
                        FROM narrative_proposal_decisions d WHERE d.proposal_id=proposal.id AND d.revision_id=revision.id), 0)
               FROM narrative_proposal_revisions revision
               JOIN narrative_proposals proposal
                 ON proposal.id = revision.proposal_id
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
               JOIN narrative_extraction_runs extraction_run
                 ON extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
              WHERE revision.id = ?1
                AND proposal_set.project_id = ?2
                AND proposal_set.set_kind = ?3
                AND extraction_run.surface_path_id = ?4";

const COUNT_SQL: &str = "SELECT CASE WHEN json_valid(revision.payload_json)
                         THEN COALESCE(json_array_length(
                                  json_extract(revision.payload_json, '$.bundle.entities')
                              ), 0)
                         ELSE 0 END,
                    CASE WHEN json_valid(revision.payload_json)
                         THEN COALESCE(json_array_length(
                                  json_extract(revision.payload_json, '$.bundle.relations')
                              ), 0)
                         ELSE 0 END,
                    CASE WHEN json_valid(revision.payload_json)
                         THEN COALESCE((
                              SELECT SUM(
                                  CASE WHEN json_valid(entity.value)
                                       THEN COALESCE(json_array_length(
                                            json_extract(entity.value, '$.evidence')
                                        ), 0)
                                       ELSE 0 END
                              )
                                FROM json_each(
                                    CASE WHEN json_valid(revision.payload_json)
                                              AND json_type(
                                               revision.payload_json,
                                               '$.bundle.entities'
                                         ) = 'array'
                                         THEN json_extract(
                                               revision.payload_json,
                                               '$.bundle.entities'
                                         )
                                         ELSE '[]' END
                                ) AS entity
                         ), 0)
                         ELSE 0 END
               FROM narrative_proposal_revisions revision
               JOIN narrative_proposals proposal
                 ON proposal.id = revision.proposal_id
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
               JOIN narrative_extraction_runs extraction_run
                 ON extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
              WHERE revision.id = ?1
                AND proposal_set.project_id = ?2
                AND proposal_set.set_kind = ?3
                AND extraction_run.surface_path_id = ?4";

const RELATED_BYTES_SQL: &[&str] = &[
    "SELECT COALESCE(SUM(COALESCE(octet_length(b.source_kind), 0) +
                    COALESCE(octet_length(b.source_key), 0) +
                    COALESCE(octet_length(b.revision_token), 0) +
                    COALESCE(octet_length(b.observed_at), 0)), 0) FROM narrative_revision_source_basis b
             WHERE b.revision_id=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(e.id), 0) +
                    COALESCE(octet_length(e.project_id), 0) +
                    COALESCE(octet_length(e.consumer_kind), 0) +
                    COALESCE(octet_length(e.consumer_key), 0) +
                    COALESCE(octet_length(e.source_object_identity), 0) +
                    COALESCE(octet_length(e.read_set_json), 0) +
                    COALESCE(octet_length(e.generated_by_transaction_id), 0) +
                    COALESCE(octet_length(e.created_at), 0) +
                    COALESCE(octet_length(e.owning_run_id), 0)), 0) FROM narrative_dependency_edges e
             WHERE e.project_id=?1 AND e.consumer_kind='proposal-revision' AND e.consumer_key=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(s.evidence_freshness), 0) +
                    COALESCE(octet_length(s.reason_code), 0) +
                    COALESCE(octet_length(s.build_action), 0) +
                    COALESCE(octet_length(s.evaluated_at_epoch_id), 0) +
                    COALESCE(octet_length(s.evaluated_at), 0)), 0) FROM narrative_dependency_edge_states s
             JOIN narrative_dependency_edges e ON e.id=s.edge_id WHERE e.project_id=?1 AND e.consumer_kind='proposal-revision' AND e.consumer_key=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(h.project_id), 0) +
                    COALESCE(octet_length(h.consumer_kind), 0) +
                    COALESCE(octet_length(h.consumer_key), 0) +
                    COALESCE(octet_length(h.active_declaration_set_id), 0) +
                    COALESCE(octet_length(h.producer_id), 0) +
                    COALESCE(octet_length(h.updated_at), 0)), 0) FROM narrative_dependency_declaration_heads h
             WHERE h.project_id=?1 AND h.consumer_kind='proposal-revision' AND h.consumer_key=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(d.id), 0) +
                    COALESCE(octet_length(d.project_id), 0) +
                    COALESCE(octet_length(d.consumer_kind), 0) +
                    COALESCE(octet_length(d.consumer_key), 0) +
                    COALESCE(octet_length(d.producer_id), 0) +
                    COALESCE(octet_length(d.dependency_set_digest), 0) +
                    COALESCE(octet_length(d.state), 0) +
                    COALESCE(octet_length(d.created_at), 0)), 0) FROM narrative_dependency_declaration_sets d
             JOIN narrative_dependency_declaration_heads h ON h.active_declaration_set_id=d.id WHERE h.project_id=?1 AND h.consumer_kind='proposal-revision' AND h.consumer_key=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(d.id), 0) +
                    COALESCE(octet_length(d.declaration_set_id), 0) +
                    COALESCE(octet_length(d.source_object_identity), 0) +
                    COALESCE(octet_length(d.dependency_key), 0) +
                    COALESCE(octet_length(d.dependency_role), 0) +
                    COALESCE(octet_length(d.role_contract_version), 0) +
                    COALESCE(octet_length(d.selector_json), 0) +
                    COALESCE(octet_length(d.selector_digest), 0) +
                    COALESCE(octet_length(d.created_at), 0)), 0) FROM narrative_dependency_declaration_entries d
             JOIN narrative_dependency_declaration_heads h ON h.active_declaration_set_id=d.declaration_set_id WHERE h.project_id=?1 AND h.consumer_kind='proposal-revision' AND h.consumer_key=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(f.evidence_freshness), 0) +
                    COALESCE(octet_length(f.build_action), 0) +
                    COALESCE(octet_length(f.semantic_epoch_id), 0) +
                    COALESCE(octet_length(f.last_evaluated_run_id), 0) +
                    COALESCE(octet_length(f.dependency_set_digest), 0) +
                    COALESCE(octet_length(f.updated_at), 0)), 0) FROM narrative_consumer_freshness f
             WHERE f.project_id=?1 AND f.consumer_kind='proposal-revision' AND f.consumer_key=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(r.semantic_epoch_id), 0)), 0) FROM narrative_extraction_runs r
             JOIN narrative_proposal_sets s ON s.run_id=r.id JOIN narrative_proposals p ON p.proposal_set_id=s.id JOIN narrative_proposal_revisions v ON v.proposal_id=p.id WHERE r.project_id=?1 AND v.id=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(e.id), 0) +
                    COALESCE(octet_length(e.type), 0) +
                    COALESCE(octet_length(e.name), 0) +
                    COALESCE(octet_length(e.summary), 0) +
                    COALESCE(octet_length(e.updated_at), 0)), 0) FROM codex_entries e
             JOIN narrative_proposal_revisions v ON v.id=?2
             JOIN json_each(CASE WHEN json_valid(v.payload_json)
                  THEN CASE WHEN json_type(v.payload_json, '$.bundle.entities')='array'
                       THEN json_extract(v.payload_json, '$.bundle.entities') ELSE '[]' END
                  ELSE '[]' END) material
               ON e.id=CASE WHEN material.type='object'
                    THEN json_extract(material.value, '$.entityId') END
             WHERE e.project_id=?1",
    "SELECT COALESCE(SUM(COALESCE(octet_length(e.id), 0) +
                    COALESCE(octet_length(e.from_codex_id), 0) +
                    COALESCE(octet_length(e.to_codex_id), 0) +
                    COALESCE(octet_length(e.relation_type), 0) +
                    COALESCE(octet_length(e.directionality), 0) +
                    COALESCE(octet_length(e.version), 0) +
                    COALESCE(octet_length(e.updated_at), 0)), 0) FROM codex_relations e
             JOIN narrative_proposal_revisions v ON v.id=?2
             JOIN json_each(CASE WHEN json_valid(v.payload_json)
                  THEN CASE WHEN json_type(v.payload_json, '$.bundle.relations')='array'
                       THEN json_extract(v.payload_json, '$.bundle.relations') ELSE '[]' END
                  ELSE '[]' END) material
               ON e.id=CASE WHEN material.type='object'
                    THEN json_extract(material.value, '$.edgeId') END
             WHERE e.project_id=?1"
];

#[cfg(test)]
mod tests {
    use super::*;

    // Related-authority tables are intentionally absent: early admission must
    // reject before attempting to read them or decode an oversized document.
    fn fixture(payload: &str, envelope: &str, family: &str) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE narrative_proposal_revisions (
                id TEXT, proposal_id TEXT, payload_json TEXT,
                reconciliation_envelope_json TEXT, origin_kind TEXT,
                reconciliation_envelope_digest TEXT, created_at TEXT);
             CREATE TABLE narrative_proposals (
                id TEXT, proposal_set_id TEXT, current_revision_id TEXT, status TEXT);
             CREATE TABLE narrative_proposal_sets (
                id TEXT, run_id TEXT, project_id TEXT, set_kind TEXT);
             CREATE TABLE narrative_extraction_runs (
                id TEXT, project_id TEXT, surface_path_id TEXT);
             CREATE TABLE narrative_proposal_decisions (
                id TEXT, proposal_id TEXT, revision_id TEXT, decision TEXT,
                decision_json TEXT, created_at TEXT, created_by TEXT,
                actor_kind TEXT, actor_id TEXT, authority_scope TEXT,
                override_field_paths_json TEXT);
             INSERT INTO narrative_proposals VALUES ('proposal','set','revision','draft');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO narrative_proposal_sets VALUES ('set','run','project',?1)",
            [family],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO narrative_extraction_runs VALUES ('run','project',?1)",
            [NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH],
        )
        .unwrap();
        conn.execute("INSERT INTO narrative_proposal_revisions VALUES ('revision','proposal',?1,?2,'test','digest','now')", params![payload,envelope]).unwrap();
        conn
    }

    #[test]
    fn oversized_documents_abort_before_json_or_related_authority_reads() {
        for (payload, envelope) in [
            ("[".repeat(INPUT_BYTES + 1), "{}".into()),
            ("{}".into(), "[".repeat(INPUT_BYTES + 1)),
        ] {
            let conn = fixture(&payload, &envelope, NIR1_ENTITY_RELATION_SET_KIND);
            assert_eq!(
                preflight_revision(&conn, "project", "revision", 500, usize::MAX)
                    .unwrap_err()
                    .to_string(),
                INPUT_LIMIT
            );
        }
        let conn = fixture("{}", "{}", "different-family");
        assert!(preflight_revision(&conn, "project", "revision", 0, 0)
            .unwrap()
            .is_none());
        assert!(preflight_revision(&conn, "project", "missing", 0, 0)
            .unwrap()
            .is_none());
    }

    #[test]
    fn mixed_material_and_decision_bytes_consume_the_callers_budget() {
        let payload =
            r#"{"bundle":{"entities":[{"evidence":[{},{}]},{"evidence":[{}]}],"relations":[{}]}}"#;
        let conn = fixture(payload, "{}", NIR1_ENTITY_RELATION_SET_KIND);
        assert_eq!(
            preflight_revision(&conn, "project", "revision", 5, INPUT_BYTES)
                .unwrap_err()
                .to_string(),
            ROW_LIMIT
        );
        conn.execute("INSERT INTO narrative_proposal_decisions (proposal_id,revision_id,decision_json) VALUES ('proposal','revision',?1)", ["x".repeat(1024)]).unwrap();
        assert_eq!(
            preflight_revision(&conn, "project", "revision", 500, 1024)
                .unwrap_err()
                .to_string(),
            INPUT_LIMIT
        );
    }
}

/// Admit A3 auxiliary stored inputs before disclosure evaluation. The caller
/// must first admit the typed Revision; this helper does not re-charge A2.
/// Scope registry reads repeat per material scene, so the entity count gives
/// a conservative upper bound (multiple entities may share one scene).
/// This is scalar input/cardinality accounting, not a bound on JSON/PM
/// expansion or heap size.
#[cfg(test)]
pub(super) fn preflight_disclosure(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    query_scene_id: &str,
    remaining_rows: usize,
    remaining_bytes: usize,
) -> anyhow::Result<DisclosureAdmission> {
    const ERROR: &str = "NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT";
    let payload_bytes: i64 = conn.query_row(
        "SELECT COALESCE(octet_length(payload_json),0)
           FROM narrative_proposal_revisions WHERE id=?1",
        [revision_id],
        |row| row.get(0),
    )?;
    let payload_bytes = usize::try_from(payload_bytes).map_err(|_| anyhow::anyhow!(ERROR))?;
    preflight_disclosure_with_payload_bytes(
        conn,
        project,
        revision_id,
        query_scene_id,
        payload_bytes,
        remaining_rows,
        remaining_bytes,
    )
}

/// A2 has already admitted the payload's scalar byte length before any JSON1
/// work. Reuse that result for A3 instead of issuing the same octet_length
/// query again. The entity cardinality query remains a separate step so an
/// oversized payload is rejected before JSON1 parses it.
pub(super) fn preflight_disclosure_with_payload_bytes(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    query_scene_id: &str,
    payload_bytes: usize,
    remaining_rows: usize,
    remaining_bytes: usize,
) -> anyhow::Result<DisclosureAdmission> {
    const ERROR: &str = "NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT";
    anyhow::ensure!(payload_bytes <= INPUT_BYTES, ERROR);
    let entity_count: i64 = conn.query_row(
        "SELECT CASE WHEN json_valid(payload_json)
                     THEN COALESCE(json_array_length(payload_json,'$.bundle.entities'),0)
                     ELSE 0 END FROM narrative_proposal_revisions WHERE id=?1",
        [revision_id],
        |row| row.get(0),
    )?;
    let registry_reads = usize::try_from(entity_count)
        .ok()
        .and_then(|count| count.checked_add(2))
        .ok_or_else(|| anyhow::anyhow!(ERROR))?;
    let mut rows = 0usize;
    for &(sql, multiplier, parameters) in DISCLOSURE_GLOBAL_ROWS_SQL {
        let value: i64 = match parameters {
            DisclosureGlobalRowsParams::Project => {
                conn.query_row(sql, [project], |row| row.get(0))?
            }
            DisclosureGlobalRowsParams::ProjectScene => {
                conn.query_row(sql, params![project, query_scene_id], |row| row.get(0))?
            }
            DisclosureGlobalRowsParams::Revision => {
                conn.query_row(sql, [revision_id], |row| row.get(0))?
            }
        };
        let multiplier = if multiplier == 0 {
            registry_reads
        } else {
            multiplier
        };
        admit_rows(&mut rows, value, multiplier, remaining_rows)?;
    }
    for sql in DISCLOSURE_MATERIAL_ROWS_SQL {
        let value: i64 = conn.query_row(sql, params![project, revision_id], |row| row.get(0))?;
        admit_rows(&mut rows, value, 1, remaining_rows)?;
    }
    let mut bytes = 0usize;
    for &(sql, multiplier) in DISCLOSURE_GLOBAL_BYTES_SQL {
        let value: i64 =
            conn.query_row(sql, params![project, revision_id, query_scene_id], |row| {
                row.get(0)
            })?;
        let multiplier = if multiplier == 0 {
            registry_reads
        } else {
            multiplier
        };
        let additional = usize::try_from(value)
            .ok()
            .and_then(|value| value.checked_mul(multiplier))
            .ok_or_else(|| anyhow::anyhow!(ERROR))?;
        bytes = bytes
            .checked_add(additional)
            .filter(|value| *value <= remaining_bytes.min(INPUT_BYTES))
            .ok_or_else(|| anyhow::anyhow!(ERROR))?;
    }
    for sql in DISCLOSURE_MATERIAL_BYTES_SQL {
        let value: i64 = conn.query_row(sql, params![project, revision_id], |row| row.get(0))?;
        bytes = bytes
            .checked_add(usize::try_from(value).map_err(|_| anyhow::anyhow!(ERROR))?)
            .filter(|value| *value <= remaining_bytes.min(INPUT_BYTES))
            .ok_or_else(|| anyhow::anyhow!(ERROR))?;
    }
    Ok(DisclosureAdmission { rows, bytes })
}

#[derive(Clone, Copy)]
enum DisclosureGlobalRowsParams {
    Project,
    ProjectScene,
    Revision,
}

const DISCLOSURE_GLOBAL_ROWS_SQL: &[(&str, usize, DisclosureGlobalRowsParams)] = &[
    (
        "SELECT COUNT(*) FROM tree_nodes WHERE project_id=?1",
        2,
        DisclosureGlobalRowsParams::Project,
    ),
    (
        "SELECT COALESCE(SUM(
                    1
                    + CASE WHEN json_valid(r.timeline_refs_json)
                           THEN COALESCE(json_array_length(r.timeline_refs_json), 0)
                           ELSE 0 END
                    + CASE WHEN json_valid(r.worldline_refs_json)
                           THEN COALESCE(json_array_length(r.worldline_refs_json), 0)
                           ELSE 0 END
                    + CASE WHEN json_valid(r.narrative_layer_refs_json)
                           THEN COALESCE(json_array_length(r.narrative_layer_refs_json), 0)
                           ELSE 0 END), 0)
           FROM narrative_scope_registries r WHERE r.project_id=?1",
        0,
        DisclosureGlobalRowsParams::Project,
    ),
    (
        "SELECT COUNT(*) FROM narrative_scene_scope_bindings
          WHERE project_id=?1",
        2,
        DisclosureGlobalRowsParams::Project,
    ),
    (
        "SELECT COUNT(*) FROM projects WHERE id=?1",
        1,
        DisclosureGlobalRowsParams::Project,
    ),
    (
        "SELECT COUNT(*) FROM tree_nodes
          WHERE project_id=?1 AND id=?2 AND node_type='scene'",
        1,
        DisclosureGlobalRowsParams::ProjectScene,
    ),
    (
        "SELECT COUNT(*) FROM codex_entries c
          JOIN tree_nodes t ON t.pov_character_id=c.id AND t.project_id=c.project_id
         WHERE t.project_id=?1 AND t.id=?2 AND t.node_type='scene'",
        1,
        DisclosureGlobalRowsParams::ProjectScene,
    ),
    (
        "SELECT COUNT(*) FROM (
             SELECT id FROM narrative_semantic_epochs
              WHERE project_id=?1 ORDER BY epoch_number DESC LIMIT 1
         )",
        1,
        DisclosureGlobalRowsParams::Project,
    ),
    (
        "SELECT COUNT(*) FROM narrative_proposal_decisions d
          JOIN narrative_proposal_revisions r
            ON r.id=d.revision_id AND r.proposal_id=d.proposal_id
         WHERE r.id=?1",
        1,
        DisclosureGlobalRowsParams::Revision,
    ),
];

const DISCLOSURE_MATERIAL_ROWS_SQL: &[&str] = &[
    "WITH material AS (
         SELECT json_extract(entity.value,'$.entityId') AS entity_id
           FROM narrative_proposal_revisions revision,
                json_each(CASE WHEN json_valid(revision.payload_json)
                     THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                          THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                     ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object'
     ) SELECT COUNT(*)
          FROM codex_entries c JOIN material m ON c.id=m.entity_id
         WHERE c.project_id=?1",
    "WITH material AS (
         SELECT json_extract(entity.value,'$.entityId') AS entity_id
           FROM narrative_proposal_revisions revision,
                json_each(CASE WHEN json_valid(revision.payload_json)
                     THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                          THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                     ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object'
     ) SELECT COUNT(*)
          FROM codex_entry_phases p
          JOIN codex_entries c ON c.id=p.entry_id
          JOIN material m ON c.id=m.entity_id
         WHERE c.project_id=?1",
    "WITH material AS (
         SELECT json_extract(entity.value,'$.entityId') AS entity_id
           FROM narrative_proposal_revisions revision,
                json_each(CASE WHEN json_valid(revision.payload_json)
                     THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                          THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                     ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object'
     ) SELECT COUNT(*)
          FROM foreshadow_codex_links link
          JOIN foreshadows f ON f.id=link.foreshadow_id
          JOIN material m ON m.entity_id=link.codex_entry_id
         WHERE f.project_id=?1",
    "WITH material AS (
         SELECT json_extract(entity.value,'$.scope.pov') AS pov_id
           FROM narrative_proposal_revisions revision,
                json_each(CASE WHEN json_valid(revision.payload_json)
                     THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                          THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                     ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object'
     ) SELECT COUNT(*)
          FROM codex_entries c JOIN material m ON c.id=m.pov_id
         WHERE c.project_id=?1",
];

const DISCLOSURE_GLOBAL_BYTES_SQL: &[(&str, usize)] = &[
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(t.id), 0) +
                COALESCE(octet_length(t.parent_id), 0) +
                COALESCE(octet_length(t.node_type), 0) +
                COALESCE(octet_length(t.sort_order), 0) +
                COALESCE(octet_length(t.story_time_order), 0) +
                COALESCE(octet_length(t.archived_at), 0) +
                COALESCE(octet_length(t.version), 0) +
                COALESCE(octet_length(t.updated_at), 0)), 0)
         FROM tree_nodes t WHERE t.project_id=?1) SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 2),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(r.registry_version), 0) +
                COALESCE(octet_length(r.timeline_refs_json), 0) +
                COALESCE(octet_length(r.worldline_refs_json), 0) +
                COALESCE(octet_length(r.narrative_layer_refs_json), 0) +
                2 * COALESCE(octet_length(r.source_token), 0) +
                COALESCE(octet_length(r.updated_at), 0)), 0)
         FROM narrative_scope_registries r WHERE r.project_id=?1) SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 0),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(b.scene_id), 0) +
                COALESCE(octet_length(b.scene_incarnation_id), 0) +
                COALESCE(octet_length(b.compatibility_marker), 0) +
                COALESCE(octet_length(b.query_identity_json), 0) +
                COALESCE(octet_length(b.material_constraint_json), 0) +
                COALESCE(octet_length(b.knowledge_holder_json), 0) +
                COALESCE(octet_length(b.audience_json), 0) +
                COALESCE(octet_length(b.source_token), 0) +
                COALESCE(octet_length(b.updated_at), 0)), 0)
         FROM narrative_scene_scope_bindings b WHERE b.project_id=?1) SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 2),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(p.phase_resolution_mode), 0)), 0)
         FROM projects p WHERE p.id=?1) SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 1),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(t.content), 0) +
                COALESCE(octet_length(t.updated_at), 0) +
                COALESCE(octet_length(t.archived_at), 0) +
                COALESCE(octet_length(t.pov_character_id), 0)), 0)
         FROM tree_nodes t WHERE t.project_id=?1 AND t.id=?3 AND t.node_type='scene') SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 1),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(c.type), 0)), 0)
         FROM codex_entries c JOIN tree_nodes t ON t.pov_character_id=c.id AND t.project_id=c.project_id WHERE t.project_id=?1 AND t.id=?3 AND t.node_type='scene') SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 1),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(e.id), 0) +
                COALESCE(octet_length(e.reason), 0) +
                COALESCE(octet_length(e.created_at), 0)), 0)
         FROM (SELECT id, reason, created_at FROM narrative_semantic_epochs WHERE project_id=?1 ORDER BY epoch_number DESC LIMIT 1) e ) SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 1),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(d.id), 0) +
                COALESCE(octet_length(d.decision), 0) +
                COALESCE(octet_length(d.decision_json), 0) +
                COALESCE(octet_length(d.created_at), 0) +
                COALESCE(octet_length(d.created_by), 0) +
                COALESCE(octet_length(d.actor_kind), 0) +
                COALESCE(octet_length(d.actor_id), 0) +
                COALESCE(octet_length(d.authority_scope), 0) +
                COALESCE(octet_length(d.override_field_paths_json), 0)), 0)
         FROM narrative_proposal_decisions d JOIN narrative_proposal_revisions r ON r.id=d.revision_id AND r.proposal_id=d.proposal_id WHERE r.id=?2) SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 1),
];

const DISCLOSURE_MATERIAL_BYTES_SQL: &[&str] = &[
    "WITH material AS (
         SELECT entity.value FROM narrative_proposal_revisions revision,
              json_each(CASE WHEN json_valid(revision.payload_json)
                   THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                        THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                   ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object') SELECT COALESCE(SUM(COALESCE(octet_length(c.context_mode), 0)), 0)
         FROM codex_entries c JOIN material m ON c.id=json_extract(m.value,'$.entityId') WHERE c.project_id=?1",
    "WITH material AS (
         SELECT entity.value FROM narrative_proposal_revisions revision,
              json_each(CASE WHEN json_valid(revision.payload_json)
                   THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                        THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                   ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object') SELECT COALESCE(SUM(COALESCE(octet_length(p.id), 0) +
                COALESCE(octet_length(p.anchor_node_id), 0) +
                COALESCE(octet_length(p.label), 0) +
                COALESCE(octet_length(p.created_at), 0) +
                COALESCE(octet_length(p.context_mode_override), 0) +
                COALESCE(octet_length(p.version), 0)), 0)
         FROM codex_entry_phases p JOIN codex_entries c ON c.id=p.entry_id JOIN material m ON c.id=json_extract(m.value,'$.entityId') WHERE c.project_id=?1",
    "WITH material AS (
         SELECT entity.value FROM narrative_proposal_revisions revision,
              json_each(CASE WHEN json_valid(revision.payload_json)
                   THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                        THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                   ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object') SELECT COALESCE(SUM(COALESCE(octet_length(c.context_mode), 0)), 0)
         FROM codex_entries c LEFT JOIN codex_entry_phases p ON p.entry_id=c.id JOIN material m ON c.id=json_extract(m.value,'$.entityId') WHERE c.project_id=?1",
    "WITH material AS (
         SELECT entity.value FROM narrative_proposal_revisions revision,
              json_each(CASE WHEN json_valid(revision.payload_json)
                   THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                        THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                   ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object') SELECT COALESCE(SUM(COALESCE(octet_length(f.id), 0) +
                COALESCE(octet_length(f.payoff_scene_id), 0)), 0)
         FROM foreshadows f JOIN foreshadow_codex_links link ON link.foreshadow_id=f.id JOIN material m ON link.codex_entry_id=json_extract(m.value,'$.entityId') WHERE f.project_id=?1",
    "WITH material AS (
         SELECT entity.value FROM narrative_proposal_revisions revision,
              json_each(CASE WHEN json_valid(revision.payload_json)
                   THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                        THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                   ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object') SELECT COALESCE(SUM(COALESCE(octet_length(c.type), 0)), 0)
         FROM codex_entries c JOIN material m ON c.id=json_extract(m.value,'$.scope.pov') WHERE c.project_id=?1"
];

#[cfg(test)]
mod disclosure_tests {
    use super::*;

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE narrative_proposal_revisions (id TEXT, proposal_id TEXT, payload_json TEXT);
             INSERT INTO narrative_proposal_revisions VALUES ('r','p','{\"bundle\":{\"entities\":[{\"entityId\":\"entity\"}]}}');
             CREATE TABLE tree_nodes (id TEXT, project_id TEXT, parent_id TEXT, node_type TEXT,
                sort_order TEXT, story_time_order TEXT, archived_at TEXT, version INTEGER,
                updated_at TEXT, content TEXT, pov_character_id TEXT);
             INSERT INTO tree_nodes (id,project_id,node_type,content) VALUES ('scene','project','scene','{}');
             CREATE TABLE projects (id TEXT, phase_resolution_mode TEXT);
             INSERT INTO projects VALUES ('project','reading');
             CREATE TABLE narrative_scope_registries (project_id TEXT,registry_version TEXT,
                timeline_refs_json TEXT,worldline_refs_json TEXT,narrative_layer_refs_json TEXT,
                source_token TEXT,updated_at TEXT);
             INSERT INTO narrative_scope_registries (project_id,timeline_refs_json) VALUES ('project','[]');
             CREATE TABLE narrative_scene_scope_bindings (project_id TEXT,scene_id TEXT,
                scene_incarnation_id TEXT,compatibility_marker TEXT,query_identity_json TEXT,
                material_constraint_json TEXT,knowledge_holder_json TEXT,audience_json TEXT,
                source_token TEXT,updated_at TEXT);
             INSERT INTO narrative_scene_scope_bindings (project_id,scene_id,query_identity_json)
                VALUES ('project','scene','{}');
             CREATE TABLE codex_entries (id TEXT,project_id TEXT,type TEXT,context_mode TEXT);
             INSERT INTO codex_entries VALUES ('entity','project','character','auto');
             CREATE TABLE codex_entry_phases (id TEXT,entry_id TEXT,anchor_node_id TEXT,label TEXT,
                created_at TEXT,context_mode_override TEXT,version INTEGER);
             INSERT INTO codex_entry_phases (id,entry_id,label) VALUES ('phase','entity','label');
             CREATE TABLE foreshadows (id TEXT,project_id TEXT,payoff_scene_id TEXT);
             CREATE TABLE foreshadow_codex_links (foreshadow_id TEXT,codex_entry_id TEXT);
             CREATE TABLE narrative_semantic_epochs (id TEXT,project_id TEXT,epoch_number INTEGER,
                reason TEXT,created_at TEXT);
             CREATE TABLE narrative_proposal_decisions (id TEXT,proposal_id TEXT,revision_id TEXT,
                decision TEXT,decision_json TEXT,created_at TEXT,created_by TEXT,actor_kind TEXT,
                actor_id TEXT,authority_scope TEXT,override_field_paths_json TEXT);",
        ).unwrap();
        conn
    }

    #[test]
    fn disclosure_admits_cumulative_inputs_and_bounds_body_phase_and_scope() {
        let conn = fixture();
        let admission = preflight_disclosure(
            &conn,
            "project",
            "r",
            "scene",
            MAX_GRAPH_RECORDS,
            INPUT_BYTES,
        )
        .unwrap();
        let bytes = admission.bytes;
        assert!(admission.rows > 0);
        assert!(bytes > 0);
        let payload_bytes: usize = conn
            .query_row(
                "SELECT octet_length(payload_json) FROM narrative_proposal_revisions WHERE id='r'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(
            preflight_disclosure_with_payload_bytes(
                &conn,
                "project",
                "r",
                "scene",
                payload_bytes,
                MAX_GRAPH_RECORDS,
                INPUT_BYTES,
            )
            .unwrap(),
            admission
        );
        assert_eq!(
            preflight_disclosure_with_payload_bytes(
                &conn,
                "project",
                "r",
                "scene",
                INPUT_BYTES + 1,
                MAX_GRAPH_RECORDS,
                INPUT_BYTES,
            )
            .unwrap_err()
            .to_string(),
            "NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT"
        );
        assert_eq!(
            preflight_disclosure(&conn, "project", "r", "scene", admission.rows, bytes).unwrap(),
            admission
        );
        assert_eq!(
            preflight_disclosure(&conn, "project", "r", "scene", admission.rows, bytes - 1)
                .unwrap_err()
                .to_string(),
            "NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT"
        );
        for sql in [
            "UPDATE tree_nodes SET content=?1",
            "UPDATE codex_entry_phases SET label=?1",
            "UPDATE narrative_scene_scope_bindings SET query_identity_json=?1",
        ] {
            let conn = fixture();
            conn.execute(sql, ["x".repeat(INPUT_BYTES + 1)]).unwrap();
            assert_eq!(
                preflight_disclosure(
                    &conn,
                    "project",
                    "r",
                    "scene",
                    MAX_GRAPH_RECORDS,
                    usize::MAX,
                )
                .unwrap_err()
                .to_string(),
                "NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT"
            );
        }
    }

    #[test]
    fn disclosure_rejects_auxiliary_row_cardinality_before_materialization() {
        let conn = fixture();
        for index in 0..256 {
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type) VALUES (?1, 'project', 'note')",
                [format!("node-{index}")],
            )
            .unwrap();
        }
        assert_eq!(
            preflight_disclosure(
                &conn,
                "project",
                "r",
                "scene",
                MAX_GRAPH_RECORDS,
                INPUT_BYTES,
            )
            .unwrap_err()
            .to_string(),
            DISCLOSURE_ROW_LIMIT
        );
    }

    #[test]
    fn disclosure_rejects_unbounded_material_phase_rows() {
        let conn = fixture();
        for index in 0..512 {
            conn.execute(
                "INSERT INTO codex_entry_phases (id, entry_id, label) VALUES (?1, 'entity', 'label')",
                [format!("phase-{index}")],
            )
            .unwrap();
        }
        assert_eq!(
            preflight_disclosure(
                &conn,
                "project",
                "r",
                "scene",
                MAX_GRAPH_RECORDS,
                INPUT_BYTES,
            )
            .unwrap_err()
            .to_string(),
            DISCLOSURE_ROW_LIMIT
        );
    }
}
