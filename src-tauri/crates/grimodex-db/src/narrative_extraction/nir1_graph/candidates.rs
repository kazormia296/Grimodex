use rusqlite::{params, Connection};

use super::super::nir1_entity_relation::{
    NIR1_ENTITY_RELATION_PROPOSAL_KIND, NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
    NIR1_ENTITY_RELATION_REVISION_ORIGIN, NIR1_ENTITY_RELATION_SET_KIND,
};
use super::super::nir1_entity_relation_index::{GraphWorkControl, GraphWorkStage};
use grimodex_core::narrative_nir1::ENTITY_RELATION_PRODUCER;

const PAGE_ROWS: usize = 16;
const INPUT_BYTES: usize = 2 * 1024 * 1024;
const INPUT_LIMIT: &str = "NIR1_GRAPH_CANDIDATE_INPUT_LIMIT";
const PAGE_SQL: &str = "SELECT rowid,
    octet_length(consumer_kind), octet_length(consumer_key)
    FROM narrative_dependency_edges INDEXED BY idx_narrative_dependency_edges_source
    WHERE project_id = ?1 AND source_object_identity = ?2 AND rowid > ?3
    ORDER BY rowid LIMIT ?4";

#[derive(Debug, PartialEq, Eq)]
pub(super) struct GraphCandidateRow {
    pub cursor: i64,
    pub consumer_kind: String,
    pub revision_id: String,
}

/// Scratch storage allocated by [`read_candidate_page`] before it materializes
/// the point lookups. The returned strings are charged by the caller as input
/// rows; this helper covers the two bounded Vec allocations that hold cursors
/// and rows while that materialization is in progress.
pub(super) fn candidate_page_scratch_bytes(limit: usize) -> anyhow::Result<usize> {
    let limit = limit.min(PAGE_ROWS);
    let cursor_bytes = limit
        .checked_mul(std::mem::size_of::<i64>())
        .ok_or_else(|| anyhow::anyhow!(INPUT_LIMIT))?;
    let row_bytes = limit
        .checked_mul(std::mem::size_of::<GraphCandidateRow>())
        .ok_or_else(|| anyhow::anyhow!(INPUT_LIMIT))?;
    std::mem::size_of::<Vec<i64>>()
        .checked_add(cursor_bytes)
        .and_then(|bytes| bytes.checked_add(std::mem::size_of::<Vec<GraphCandidateRow>>()))
        .and_then(|bytes| bytes.checked_add(row_bytes))
        .ok_or_else(|| anyhow::anyhow!(INPUT_LIMIT))
}

pub(super) fn source_input_bytes(entity: &str) -> anyhow::Result<usize> {
    let bytes = entity
        .len()
        .checked_add("codex:".len())
        .ok_or_else(|| anyhow::anyhow!(INPUT_LIMIT))?;
    anyhow::ensure!(bytes <= INPUT_BYTES, INPUT_LIMIT);
    Ok(bytes)
}

/// Page the reverse source index without filtering consumer kinds: decoys must
/// consume the caller's admission budget too. The caller owns the snapshot and
/// cumulative row/byte budgets; byte cost is the sum of both returned strings.
#[cfg(test)]
pub(super) fn read_candidate_page(
    conn: &Connection,
    project: &str,
    entity: &str,
    cursor: i64,
    remaining_rows: usize,
    remaining_bytes: usize,
) -> anyhow::Result<Vec<GraphCandidateRow>> {
    read_candidate_page_with_admission(
        conn,
        project,
        entity,
        cursor,
        remaining_rows,
        remaining_bytes,
        |_, _| Ok(()),
    )
}

/// Page the reverse source index and invoke `admit` after scalar lengths have
/// been checked but before the point lookups materialize either returned
/// string. The graph reader uses this boundary to charge raw candidate bytes
/// before SQLite allocates the page's `String` values.
pub(super) fn read_candidate_page_with_admission(
    conn: &Connection,
    project: &str,
    entity: &str,
    cursor: i64,
    remaining_rows: usize,
    remaining_bytes: usize,
    admit: impl FnOnce(usize, usize) -> anyhow::Result<()>,
) -> anyhow::Result<Vec<GraphCandidateRow>> {
    anyhow::ensure!(cursor >= 0, "NIR1_GRAPH_INVALID_CANDIDATE_CURSOR");
    source_input_bytes(entity)?;
    let limit = remaining_rows.min(PAGE_ROWS);
    if limit == 0 {
        return Ok(Vec::new());
    }
    let source = format!("codex:{entity}");
    let mut statement = conn.prepare(PAGE_SQL)?;
    let mut rows = statement.query(params![project, source, cursor, limit as i64])?;
    let mut cursors = Vec::with_capacity(limit);
    let mut bytes = 0usize;
    while let Some(row) = rows.next()? {
        // octet_length reads stored byte lengths without materializing oversized
        // SQLite values. Do not SELECT the strings until the entire page fits.
        let kind_bytes =
            usize::try_from(row.get::<_, i64>(1)?).map_err(|_| anyhow::anyhow!(INPUT_LIMIT))?;
        let revision_bytes =
            usize::try_from(row.get::<_, i64>(2)?).map_err(|_| anyhow::anyhow!(INPUT_LIMIT))?;
        bytes = bytes
            .checked_add(kind_bytes)
            .and_then(|value| value.checked_add(revision_bytes))
            .ok_or_else(|| anyhow::anyhow!(INPUT_LIMIT))?;
        anyhow::ensure!(bytes <= remaining_bytes.min(INPUT_BYTES), INPUT_LIMIT);
        cursors.push(row.get::<_, i64>(0)?);
    }
    drop(rows);
    admit(cursors.len(), bytes)?;
    let mut point = conn.prepare(
        "SELECT consumer_kind, consumer_key FROM narrative_dependency_edges
         WHERE rowid=?1 AND project_id=?2 AND source_object_identity=?3",
    )?;
    let mut result = Vec::with_capacity(cursors.len());
    for cursor in cursors {
        result.push(point.query_row(params![cursor, project, source], |row| {
            Ok(GraphCandidateRow {
                cursor,
                consumer_kind: row.get(0)?,
                revision_id: row.get(1)?,
            })
        })?);
    }
    Ok(result)
}

/// Prove the proposal-revision reverse index that the request-local pager
/// consumes. The semantic-index registration proof covers a different
/// consumer, so it cannot establish that every current typed Entity has its
/// `codex:<id>` row under the proposal Revision consumer. This is a
/// maintenance-time whole-project check; the bounded query never substitutes
/// a scan when the proof is absent.
pub(super) fn verify_complete_source_index(
    conn: &Connection,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<bool> {
    const FAMILY: &str = "proposal-revision";
    let malformed: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1
               FROM narrative_proposal_revisions r
               JOIN narrative_proposals p ON p.id=r.proposal_id
               JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id
               JOIN narrative_extraction_runs run ON run.id=s.run_id
                AND run.project_id=s.project_id
              WHERE s.project_id=?1
                AND s.set_kind=?2
                AND run.surface_path_id=?3
                AND p.status='approved'
                AND p.current_revision_id=r.id
                AND p.kind=?4
                AND r.origin_kind=?5
                AND (json_valid(r.payload_json)=0
                     OR json_extract(
                          CASE WHEN json_valid(r.payload_json)
                               THEN r.payload_json ELSE '{}' END,
                          '$.schemaVersion'
                        ) IS NOT 1
                     OR json_extract(
                          CASE WHEN json_valid(r.payload_json)
                               THEN r.payload_json ELSE '{}' END,
                          '$.kind'
                        ) IS NOT ?4
                     OR json_extract(
                          CASE WHEN json_valid(r.payload_json)
                               THEN r.payload_json ELSE '{}' END,
                          '$.producer'
                        ) IS NOT ?6
                     OR json_extract(
                          CASE WHEN json_valid(r.payload_json)
                               THEN r.payload_json ELSE '{}' END,
                          '$.projectId'
                        ) IS NOT s.project_id
                     OR json_extract(
                          CASE WHEN json_valid(r.payload_json)
                               THEN r.payload_json ELSE '{}' END,
                          '$.revisionId'
                        ) IS NOT r.id
                     OR json_type(
                          CASE WHEN json_valid(r.payload_json)
                               THEN r.payload_json ELSE '{}' END,
                          '$.bundle.entities'
                        )<>'array'
                     OR EXISTS(
                          SELECT 1 FROM json_each(
                              CASE WHEN json_type(
                                           CASE WHEN json_valid(r.payload_json)
                                                THEN r.payload_json ELSE '{}' END,
                                           '$.bundle.entities'
                                       )='array'
                                   THEN json_extract(r.payload_json,'$.bundle.entities')
                                   ELSE '[]' END
                          ) entity
                           WHERE entity.type<>'object'
                              OR json_type(
                                   CASE WHEN json_valid(entity.value)
                                        THEN entity.value ELSE '{}' END,
                                   '$.entityId'
                                 )<>'text'
                              OR trim(json_extract(
                                   CASE WHEN json_valid(entity.value)
                                        THEN entity.value ELSE '{}' END,
                                   '$.entityId'
                              ))=''
                     ))
         )",
        params![
            project,
            NIR1_ENTITY_RELATION_SET_KIND,
            NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            NIR1_ENTITY_RELATION_PROPOSAL_KIND,
            NIR1_ENTITY_RELATION_REVISION_ORIGIN,
            ENTITY_RELATION_PRODUCER,
        ],
        |row| row.get(0),
    )?;
    if malformed {
        return Ok(false);
    }
    control.check(GraphWorkStage::CompleteRegistration)?;

    let missing: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1
               FROM narrative_proposal_revisions r
               JOIN narrative_proposals p ON p.id=r.proposal_id
               JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id
               JOIN narrative_extraction_runs run ON run.id=s.run_id
                AND run.project_id=s.project_id
               CROSS JOIN json_each(r.payload_json,'$.bundle.entities') entity
              WHERE s.project_id=?1
                AND s.set_kind=?2
                AND run.surface_path_id=?3
                AND p.status='approved'
                AND p.current_revision_id=r.id
                AND p.kind=?4
                AND r.origin_kind=?5
                AND json_valid(r.payload_json)=1
                AND json_extract(r.payload_json,'$.schemaVersion')=1
                AND json_extract(r.payload_json,'$.kind')=?4
                AND json_extract(r.payload_json,'$.producer')=?6
                AND json_extract(r.payload_json,'$.projectId')=s.project_id
                AND json_extract(r.payload_json,'$.revisionId')=r.id
                AND NOT EXISTS(
                    SELECT 1
                      FROM narrative_dependency_edges edge
                     WHERE edge.project_id=s.project_id
                       AND edge.consumer_kind=?7
                       AND edge.consumer_key=r.id
                       AND edge.source_object_identity=
                           'codex:' || json_extract(entity.value,'$.entityId')
                )
         )",
        params![
            project,
            NIR1_ENTITY_RELATION_SET_KIND,
            NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            NIR1_ENTITY_RELATION_PROPOSAL_KIND,
            NIR1_ENTITY_RELATION_REVISION_ORIGIN,
            ENTITY_RELATION_PRODUCER,
            FAMILY,
        ],
        |row| row.get(0),
    )?;
    if missing {
        return Ok(false);
    }
    control.check(GraphWorkStage::CompleteRegistration)?;

    let duplicate: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1
               FROM narrative_dependency_edges edge
               JOIN narrative_proposal_revisions r ON r.id=edge.consumer_key
               JOIN narrative_proposals p ON p.id=r.proposal_id
               JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id
               JOIN narrative_extraction_runs run ON run.id=s.run_id
                AND run.project_id=s.project_id
              WHERE edge.project_id=?1
                AND edge.consumer_kind=?7
                AND s.project_id=?1
                AND s.set_kind=?2
                AND run.surface_path_id=?3
                AND p.status='approved'
                AND p.current_revision_id=r.id
                AND p.kind=?4
                AND r.origin_kind=?5
                AND json_valid(r.payload_json)=1
                AND json_extract(r.payload_json,'$.schemaVersion')=1
                AND json_extract(r.payload_json,'$.kind')=?4
                AND json_extract(r.payload_json,'$.producer')=?6
                AND json_extract(r.payload_json,'$.projectId')=s.project_id
                AND json_extract(r.payload_json,'$.revisionId')=r.id
                AND edge.source_object_identity LIKE 'codex:%'
              GROUP BY edge.consumer_key, edge.source_object_identity
             HAVING COUNT(*)<>1
         )",
        params![
            project,
            NIR1_ENTITY_RELATION_SET_KIND,
            NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            NIR1_ENTITY_RELATION_PROPOSAL_KIND,
            NIR1_ENTITY_RELATION_REVISION_ORIGIN,
            ENTITY_RELATION_PRODUCER,
            FAMILY,
        ],
        |row| row.get(0),
    )?;
    if duplicate {
        return Ok(false);
    }
    control.check(GraphWorkStage::CompleteRegistration)?;

    let unexpected: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1
               FROM narrative_dependency_edges edge
               JOIN narrative_proposal_revisions r ON r.id=edge.consumer_key
               JOIN narrative_proposals p ON p.id=r.proposal_id
               JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id
               JOIN narrative_extraction_runs run ON run.id=s.run_id
                AND run.project_id=s.project_id
              WHERE edge.project_id=?1
                AND edge.consumer_kind=?7
                AND s.project_id=?1
                AND s.set_kind=?2
                AND run.surface_path_id=?3
                AND p.status='approved'
                AND p.current_revision_id=r.id
                AND p.kind=?4
                AND r.origin_kind=?5
                AND json_valid(r.payload_json)=1
                AND json_extract(r.payload_json,'$.schemaVersion')=1
                AND json_extract(r.payload_json,'$.kind')=?4
                AND json_extract(r.payload_json,'$.producer')=?6
                AND json_extract(r.payload_json,'$.projectId')=s.project_id
                AND json_extract(r.payload_json,'$.revisionId')=r.id
                AND edge.source_object_identity LIKE 'codex:%'
                AND NOT EXISTS(
                    SELECT 1
                      FROM json_each(r.payload_json,'$.bundle.entities') entity
                     WHERE edge.source_object_identity=
                           'codex:' || json_extract(entity.value,'$.entityId')
                )
         )",
        params![
            project,
            NIR1_ENTITY_RELATION_SET_KIND,
            NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            NIR1_ENTITY_RELATION_PROPOSAL_KIND,
            NIR1_ENTITY_RELATION_REVISION_ORIGIN,
            ENTITY_RELATION_PRODUCER,
            FAMILY,
        ],
        |row| row.get(0),
    )?;
    Ok(!unexpected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE narrative_dependency_edges (
                project_id TEXT NOT NULL, source_object_identity TEXT NOT NULL,
                consumer_kind TEXT NOT NULL, consumer_key TEXT NOT NULL);
             CREATE INDEX idx_narrative_dependency_edges_source
                ON narrative_dependency_edges(project_id, source_object_identity);",
        )
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, project: &str, source: &str, kind: &str, key: &str) {
        conn.execute(
            "INSERT INTO narrative_dependency_edges VALUES (?1, ?2, ?3, ?4)",
            params![project, source, kind, key],
        )
        .unwrap();
    }

    fn all_pages(conn: &Connection) -> Vec<GraphCandidateRow> {
        let mut result = Vec::new();
        let mut cursor = 0;
        loop {
            let page = read_candidate_page(conn, "p", "seed", cursor, 100, INPUT_BYTES).unwrap();
            assert!(page.len() <= PAGE_ROWS);
            let Some(last) = page.last() else { break };
            cursor = last.cursor;
            result.extend(page);
        }
        result
    }

    fn assert_indexed_seek(conn: &Connection) {
        let plan = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {PAGE_SQL}"))
            .unwrap()
            .query_map(params!["p", "codex:seed", 0, PAGE_ROWS as i64], |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .join("\n");
        assert!(
            plan.contains("idx_narrative_dependency_edges_source"),
            "{plan}"
        );
        assert!(
            plan.contains("project_id=? AND source_object_identity=? AND rowid>?"),
            "{plan}"
        );
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    }

    #[test]
    fn source_seek_pages_include_decoys_and_ignore_unrelated_rows() {
        let conn = fixture();
        let mut expected = Vec::new();
        for index in 0..35 {
            let kind = if index % 2 == 0 {
                "nir1.entity-relation"
            } else {
                "decoy"
            };
            let key = format!("revision-{index}");
            insert(&conn, "p", "codex:seed", kind, &key);
            expected.push(GraphCandidateRow {
                cursor: conn.last_insert_rowid(),
                consumer_kind: kind.into(),
                revision_id: key,
            });
            insert(&conn, "other-project", "codex:seed", "decoy", "other");
        }
        assert_indexed_seek(&conn);
        assert_eq!(all_pages(&conn), expected);
        for index in 0..600 {
            insert(
                &conn,
                "p",
                &format!("codex:unrelated-{index}"),
                "decoy",
                "other",
            );
        }
        assert_indexed_seek(&conn);
        assert_eq!(all_pages(&conn), expected);
        assert_eq!(
            read_candidate_page(&conn, "p", "seed", 0, 3, INPUT_BYTES)
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn scalar_preflight_enforces_cumulative_bytes_and_input_bounds() {
        let conn = fixture();
        insert(&conn, "p", "codex:seed", "é", "r\0x");
        insert(&conn, "p", "codex:seed", "k", "r");
        assert_eq!(
            read_candidate_page(&conn, "p", "seed", 0, 16, 7)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            read_candidate_page(&conn, "p", "seed", 0, 16, 6)
                .unwrap_err()
                .to_string(),
            INPUT_LIMIT
        );
        assert!(read_candidate_page(&conn, "p", "seed", -1, 16, INPUT_BYTES).is_err());
        assert!(
            read_candidate_page(&conn, "p", &"x".repeat(INPUT_BYTES), 0, 16, INPUT_BYTES).is_err()
        );
        insert(&conn, "p", "codex:oversized", "k", &"x".repeat(INPUT_BYTES));
        assert_eq!(
            read_candidate_page(&conn, "p", "oversized", 0, 16, usize::MAX)
                .unwrap_err()
                .to_string(),
            INPUT_LIMIT
        );
        assert!(read_candidate_page(&conn, "p", "seed", 0, 0, 0)
            .unwrap()
            .is_empty());
    }
}
