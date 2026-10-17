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

/// The Revisions the registration proof is about: the current, approved typed
/// Revisions of this project and surface. The statements bind `?1` to the
/// project, `?2` to the Set kind, `?3` to the review surface, `?4` to the
/// Proposal kind and `?5` to the Revision origin.
const QUALIFYING_REVISIONS: &str = "WITH qualifying(id, project_id) AS MATERIALIZED (
             SELECT r.id, s.project_id
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
         ) ";

// The four statements read a payload only through `qualifying`. Each starts from
// that set and reaches `narrative_proposal_revisions` by primary key from it, and
// `CROSS JOIN` fixes that order: SQLite never joins the left table after the
// right one. A payload is therefore read only for a Revision of the set.
//
// Filtering the same Revisions with `WHERE` terms on `p`, `s` and `run` is not
// enough, and neither is a `CASE` that repeats those comparisons. SQLite may
// evaluate a term that mentions only `r` (such as `json_valid(r.payload_json)`)
// as soon as `r` is read, before it has looked at `p`, `s` and `run`, and so
// parse the payload of a draft, a rejection, a stale Revision or another
// surface's Revision, whose size nothing bounds. It also propagates a `WHERE`
// term `column = constant` into every other expression of the statement, which
// turns a repeated comparison inside a `CASE` into a tautology (observed: the
// payloads of other projects and surfaces were still parsed). A set that is
// selected by its own `SELECT` is outside that rewrite.

const SOURCE_INDEX_MALFORMED_SQL: &str = "SELECT EXISTS(
             SELECT 1
               FROM qualifying q
               CROSS JOIN narrative_proposal_revisions r ON r.id=q.id
              WHERE (json_valid(r.payload_json)=0
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
                        ) IS NOT q.project_id
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
         )";

const SOURCE_INDEX_MISSING_SQL: &str = "SELECT EXISTS(
             SELECT 1
               FROM qualifying q
               CROSS JOIN narrative_proposal_revisions r ON r.id=q.id
               CROSS JOIN json_each(r.payload_json,'$.bundle.entities') entity
              WHERE json_valid(r.payload_json)=1
                AND json_extract(r.payload_json,'$.schemaVersion')=1
                AND json_extract(r.payload_json,'$.kind')=?4
                AND json_extract(r.payload_json,'$.producer')=?6
                AND json_extract(r.payload_json,'$.projectId')=q.project_id
                AND json_extract(r.payload_json,'$.revisionId')=r.id
                AND NOT EXISTS(
                    SELECT 1
                      FROM narrative_dependency_edges edge
                     WHERE edge.project_id=q.project_id
                       AND edge.consumer_kind=?7
                       AND edge.consumer_key=r.id
                       AND edge.source_object_identity=
                           'codex:' || json_extract(entity.value,'$.entityId')
                )
         )";

const SOURCE_INDEX_DUPLICATE_SQL: &str = "SELECT EXISTS(
             SELECT 1
               FROM qualifying q
               CROSS JOIN narrative_dependency_edges edge ON edge.consumer_key=q.id
               CROSS JOIN narrative_proposal_revisions r ON r.id=q.id
              WHERE edge.project_id=?1
                AND edge.consumer_kind=?7
                AND json_valid(r.payload_json)=1
                AND json_extract(r.payload_json,'$.schemaVersion')=1
                AND json_extract(r.payload_json,'$.kind')=?4
                AND json_extract(r.payload_json,'$.producer')=?6
                AND json_extract(r.payload_json,'$.projectId')=q.project_id
                AND json_extract(r.payload_json,'$.revisionId')=r.id
                AND edge.source_object_identity LIKE 'codex:%'
              GROUP BY edge.consumer_key, edge.source_object_identity
             HAVING COUNT(*)<>1
         )";

const SOURCE_INDEX_UNEXPECTED_SQL: &str = "SELECT EXISTS(
             SELECT 1
               FROM qualifying q
               CROSS JOIN narrative_dependency_edges edge ON edge.consumer_key=q.id
               CROSS JOIN narrative_proposal_revisions r ON r.id=q.id
              WHERE edge.project_id=?1
                AND edge.consumer_kind=?7
                AND json_valid(r.payload_json)=1
                AND json_extract(r.payload_json,'$.schemaVersion')=1
                AND json_extract(r.payload_json,'$.kind')=?4
                AND json_extract(r.payload_json,'$.producer')=?6
                AND json_extract(r.payload_json,'$.projectId')=q.project_id
                AND json_extract(r.payload_json,'$.revisionId')=r.id
                AND edge.source_object_identity LIKE 'codex:%'
                AND NOT EXISTS(
                    SELECT 1
                      FROM json_each(r.payload_json,'$.bundle.entities') entity
                     WHERE edge.source_object_identity=
                           'codex:' || json_extract(entity.value,'$.entityId')
                )
         )";

/// One of the proof's statements: [`QUALIFYING_REVISIONS`] first, then the
/// statement that reads payloads through it.
fn source_index_sql(statement: &str) -> String {
    format!("{QUALIFYING_REVISIONS}{statement}")
}

/// Prove the proposal-revision reverse index that the request-local pager
/// consumes. The semantic-index registration proof covers a different
/// consumer, so it cannot establish that every current typed Entity has its
/// `codex:<id>` row under the proposal Revision consumer. This is a
/// maintenance-time whole-project check; the bounded query never substitutes
/// a scan when the proof is absent.
///
/// It parses the payload of every current approved typed Revision of the
/// project, and of no other Revision (see [`QUALIFYING_REVISIONS`]).
pub(super) fn verify_complete_source_index(
    conn: &Connection,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<bool> {
    const FAMILY: &str = "proposal-revision";
    let malformed: bool = conn.query_row(
        &source_index_sql(SOURCE_INDEX_MALFORMED_SQL),
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
        &source_index_sql(SOURCE_INDEX_MISSING_SQL),
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
        &source_index_sql(SOURCE_INDEX_DUPLICATE_SQL),
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
        &source_index_sql(SOURCE_INDEX_UNEXPECTED_SQL),
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
    use grimodex_core::narrative_nir1::{
        validate_entity_relation_bundle, EntityInput, EntityRelationBundle, EvidenceInput,
        ScopeBinding, ScopeValue,
    };

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

    fn source_index_fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE narrative_dependency_edges (
                project_id TEXT, source_object_identity TEXT, consumer_kind TEXT, consumer_key TEXT);
             CREATE TABLE narrative_proposal_revisions (
                id TEXT, proposal_id TEXT, origin_kind TEXT, payload_json TEXT);
             CREATE TABLE narrative_proposals (
                id TEXT, proposal_set_id TEXT, status TEXT, current_revision_id TEXT, kind TEXT);
             CREATE TABLE narrative_proposal_sets (
                id TEXT, run_id TEXT, project_id TEXT, set_kind TEXT);
             CREATE TABLE narrative_extraction_runs (
                id TEXT, project_id TEXT, surface_path_id TEXT);",
        )
        .unwrap();
        let bundle = EntityRelationBundle {
            project_id: "project".into(),
            revision_id: "revision".into(),
            producer: ENTITY_RELATION_PRODUCER.into(),
            entities: vec![EntityInput {
                entity_id: "entity".into(),
                entity_type: "character".into(),
                label: "Entity".into(),
                source_token: "v1:entity".into(),
                scope: ScopeBinding {
                    reading: ScopeValue::Exact {
                        value: "scene:s1".into(),
                    },
                    story: ScopeValue::NotApplicable {
                        reason: "reader-reference-purpose".into(),
                    },
                    auto: ScopeValue::NotApplicable {
                        reason: "reader-reference-purpose".into(),
                    },
                    phase: "draft".into(),
                    reveal: "reader".into(),
                    pov: None,
                    authority_revision:
                        "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                            .into(),
                },
                evidence: vec![EvidenceInput {
                    evidence_id: "evidence:entity".into(),
                    source_ref: "scene:s1".into(),
                    quote: "Entity appears".into(),
                    start_utf16: 0,
                    end_utf16: 14,
                }],
            }],
            relations: vec![],
        };
        validate_entity_relation_bundle(&bundle).expect("typed fixture bundle must be valid");
        let payload = serde_json::json!({
            "schemaVersion": 1,
            "kind": NIR1_ENTITY_RELATION_PROPOSAL_KIND,
            "producer": ENTITY_RELATION_PRODUCER,
            "projectId": "project",
            "revisionId": "revision",
            "bundle": bundle,
        })
        .to_string();
        conn.execute(
            "INSERT INTO narrative_extraction_runs VALUES ('run','project',?1)",
            [NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO narrative_proposal_sets VALUES ('set','run','project',?1)",
            [NIR1_ENTITY_RELATION_SET_KIND],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO narrative_proposals VALUES (
                'proposal','set','approved','revision',?1
            )",
            [NIR1_ENTITY_RELATION_PROPOSAL_KIND],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO narrative_proposal_revisions VALUES ('revision','proposal',?1,?2)",
            params![NIR1_ENTITY_RELATION_REVISION_ORIGIN, payload],
        )
        .unwrap();
        insert(
            &conn,
            "project",
            "codex:entity",
            "proposal-revision",
            "revision",
        );
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
    fn complete_source_index_requires_one_proposal_revision_edge_per_entity() {
        let conn = source_index_fixture();
        let mut control =
            crate::narrative_extraction::nir1_entity_relation_index::NeverStopGraphWorkControl;

        assert!(verify_complete_source_index(&conn, "project", &mut control).unwrap());

        conn.execute(
            "DELETE FROM narrative_dependency_edges
              WHERE project_id='project' AND source_object_identity='codex:entity'
                AND consumer_kind='proposal-revision' AND consumer_key='revision'",
            [],
        )
        .unwrap();
        assert!(!verify_complete_source_index(&conn, "project", &mut control).unwrap());

        insert(
            &conn,
            "project",
            "codex:entity",
            "proposal-revision",
            "revision",
        );
        assert!(verify_complete_source_index(&conn, "project", &mut control).unwrap());
        insert(
            &conn,
            "project",
            "codex:entity",
            "proposal-revision",
            "revision",
        );
        assert!(!verify_complete_source_index(&conn, "project", &mut control).unwrap());
    }

    #[test]
    fn complete_source_index_rejects_unexpected_proposal_revision_edges() {
        let conn = source_index_fixture();
        let mut control =
            crate::narrative_extraction::nir1_entity_relation_index::NeverStopGraphWorkControl;

        assert!(verify_complete_source_index(&conn, "project", &mut control).unwrap());
        insert(
            &conn,
            "other-project",
            "codex:unlisted",
            "proposal-revision",
            "revision",
        );
        insert(
            &conn,
            "project",
            "codex:unlisted",
            "other-consumer",
            "revision",
        );
        assert!(verify_complete_source_index(&conn, "project", &mut control).unwrap());

        insert(
            &conn,
            "project",
            "codex:unlisted",
            "proposal-revision",
            "revision",
        );
        assert!(!verify_complete_source_index(&conn, "project", &mut control).unwrap());
    }

    #[test]
    fn complete_source_index_rejects_malformed_revision_payloads() {
        let conn = source_index_fixture();
        let mut control =
            crate::narrative_extraction::nir1_entity_relation_index::NeverStopGraphWorkControl;
        let valid_payload: String = conn
            .query_row(
                "SELECT payload_json FROM narrative_proposal_revisions WHERE id='revision'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert!(verify_complete_source_index(&conn, "project", &mut control).unwrap());

        conn.execute(
            "UPDATE narrative_proposal_revisions SET payload_json='{' WHERE id='revision'",
            [],
        )
        .unwrap();
        assert!(!verify_complete_source_index(&conn, "project", &mut control).unwrap());

        conn.execute(
            "UPDATE narrative_proposal_revisions SET payload_json=?1 WHERE id='revision'",
            [&valid_payload],
        )
        .unwrap();
        assert!(verify_complete_source_index(&conn, "project", &mut control).unwrap());

        let mut blank_entity_id: serde_json::Value = serde_json::from_str(&valid_payload).unwrap();
        blank_entity_id["bundle"]["entities"][0]["entityId"] = String::new().into();
        conn.execute(
            "UPDATE narrative_proposal_revisions SET payload_json=?1 WHERE id='revision'",
            [blank_entity_id.to_string()],
        )
        .unwrap();
        assert!(!verify_complete_source_index(&conn, "project", &mut control).unwrap());
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

    // ---- the registration proof parses the payload of nothing but its subject ----

    /// The tables the proof reads, with the indexes the real schema has: the
    /// proposal tables have primary keys only, the edge table two secondary
    /// indexes. The proof's plan depends on them.
    fn gate_fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE narrative_dependency_edges (
                project_id TEXT NOT NULL, source_object_identity TEXT NOT NULL,
                consumer_kind TEXT NOT NULL, consumer_key TEXT NOT NULL);
             CREATE INDEX idx_narrative_dependency_edges_source
                ON narrative_dependency_edges(project_id, source_object_identity);
             CREATE INDEX idx_narrative_dependency_edges_consumer
                ON narrative_dependency_edges(project_id, consumer_kind, consumer_key);
             CREATE TABLE narrative_proposal_revisions (
                id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL,
                origin_kind TEXT NOT NULL, payload_json TEXT NOT NULL);
             CREATE TABLE narrative_proposals (
                id TEXT PRIMARY KEY, proposal_set_id TEXT NOT NULL, status TEXT NOT NULL,
                current_revision_id TEXT, kind TEXT NOT NULL);
             CREATE TABLE narrative_proposal_sets (
                id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
                set_kind TEXT NOT NULL);
             CREATE TABLE narrative_extraction_runs (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, surface_path_id TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    /// Everything that makes a Revision a proof subject, and one way each of them
    /// can be wrong.
    #[derive(Clone, Copy)]
    struct Subject<'a> {
        project: &'a str,
        surface: &'a str,
        set_kind: &'a str,
        proposal_kind: &'a str,
        origin: &'a str,
        status: &'a str,
        current: bool,
    }

    const SUBJECT: Subject<'static> = Subject {
        project: "project",
        surface: NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
        set_kind: NIR1_ENTITY_RELATION_SET_KIND,
        proposal_kind: NIR1_ENTITY_RELATION_PROPOSAL_KIND,
        origin: NIR1_ENTITY_RELATION_REVISION_ORIGIN,
        status: "approved",
        current: true,
    };

    /// One Revision with its Run, Set and Proposal, and the reverse-index edge for
    /// its Entity. A `"marker"` in the payload ties a JSON call to the Revision it
    /// parsed.
    fn add_gate_revision(conn: &Connection, name: &str, subject: Subject<'_>, payload: &str) {
        let revision = format!("rev-{name}");
        conn.execute(
            "INSERT INTO narrative_extraction_runs VALUES (?1, ?2, ?3)",
            params![format!("run-{name}"), subject.project, subject.surface],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO narrative_proposal_sets VALUES (?1, ?2, ?3, ?4)",
            params![
                format!("set-{name}"),
                format!("run-{name}"),
                subject.project,
                subject.set_kind
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO narrative_proposals VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                format!("proposal-{name}"),
                format!("set-{name}"),
                subject.status,
                if subject.current {
                    revision.as_str()
                } else {
                    "rev-gone"
                },
                subject.proposal_kind
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO narrative_proposal_revisions VALUES (?1, ?2, ?3, ?4)",
            params![
                revision,
                format!("proposal-{name}"),
                subject.origin,
                payload.replace("@MARKER@", &name.to_uppercase())
            ],
        )
        .unwrap();
        insert(
            conn,
            subject.project,
            "codex:entity",
            "proposal-revision",
            &revision,
        );
    }

    /// The payload the proof accepts for `rev-ok`.
    fn gate_subject_payload() -> String {
        let fixture = source_index_fixture();
        let stored: String = fixture
            .query_row(
                "SELECT payload_json FROM narrative_proposal_revisions",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let mut payload: serde_json::Value = serde_json::from_str(&stored).unwrap();
        payload["revisionId"] = "rev-ok".into();
        payload["marker"] = "@MARKER@".into();
        payload.to_string()
    }

    /// A decoy's payload is not even JSON: anything that parses it shows up.
    const DECOY_PAYLOAD: &str = "{\"marker\":\"@MARKER@\"";

    /// The proof's subject (`rev-ok`) and one decoy for each way a Revision can fail
    /// to be a subject: a draft, a rejection, a Revision that is no longer current,
    /// and a different project, review surface, Set kind, Proposal kind or origin.
    fn gate_project() -> Connection {
        let conn = gate_fixture();
        add_gate_revision(&conn, "ok", SUBJECT, &gate_subject_payload());
        for (name, subject) in [
            (
                "draft",
                Subject {
                    status: "unreviewed",
                    ..SUBJECT
                },
            ),
            (
                "rejected",
                Subject {
                    status: "rejected",
                    ..SUBJECT
                },
            ),
            (
                "stale",
                Subject {
                    current: false,
                    ..SUBJECT
                },
            ),
            (
                "other-project",
                Subject {
                    project: "other-project",
                    ..SUBJECT
                },
            ),
            (
                "other-surface",
                Subject {
                    surface: "other-surface",
                    ..SUBJECT
                },
            ),
            (
                "other-set",
                Subject {
                    set_kind: "other.set@1",
                    ..SUBJECT
                },
            ),
            (
                "other-kind",
                Subject {
                    proposal_kind: "other.kind@1",
                    ..SUBJECT
                },
            ),
            (
                "other-origin",
                Subject {
                    origin: "legacy-unbound",
                    ..SUBJECT
                },
            ),
        ] {
            add_gate_revision(&conn, name, subject, DECOY_PAYLOAD);
        }
        conn
    }

    /// Replace SQLite's `json_valid`, `json_extract` and `json_type` on this
    /// connection with wrappers that note which marked payload they were handed and
    /// then ask a second connection's built-in function for the answer. Returns the
    /// notes as `function:MARKER`.
    fn record_json_calls(conn: &Connection) -> std::sync::Arc<std::sync::Mutex<Vec<String>>> {
        use rusqlite::functions::FunctionFlags;
        use rusqlite::types::Value;
        use std::sync::{Arc, Mutex};
        let calls = Arc::new(Mutex::new(Vec::new()));
        let builtin = Arc::new(Mutex::new(Connection::open_in_memory().unwrap()));
        for (name, arity) in [
            ("json_valid", 1),
            ("json_extract", -1),
            ("json_type", 1),
            ("json_type", 2),
        ] {
            let calls = Arc::clone(&calls);
            let builtin = Arc::clone(&builtin);
            conn.create_scalar_function(
                name,
                arity,
                FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
                move |context| {
                    let arguments = (0..context.len())
                        .map(|index| context.get::<Value>(index))
                        .collect::<rusqlite::Result<Vec<Value>>>()?;
                    if let Some(Value::Text(text)) = arguments.first() {
                        if let Some(start) = text.find("\"marker\":\"") {
                            let rest = &text[start + "\"marker\":\"".len()..];
                            let marker = &rest[..rest.find('"').unwrap_or(rest.len())];
                            calls.lock().unwrap().push(format!("{name}:{marker}"));
                        }
                    }
                    let placeholders: Vec<String> = (1..=arguments.len())
                        .map(|index| format!("?{index}"))
                        .collect();
                    let answer: Value = builtin.lock().unwrap().query_row(
                        &format!("SELECT {name}({})", placeholders.join(", ")),
                        rusqlite::params_from_iter(arguments.iter()),
                        |row| row.get(0),
                    )?;
                    Ok(answer)
                },
            )
            .unwrap();
        }
        calls
    }

    fn marked_payloads(
        calls: &std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) -> std::collections::BTreeSet<String> {
        std::mem::take(&mut *calls.lock().unwrap())
            .into_iter()
            .filter_map(|call| call.split_once(':').map(|(_, marker)| marker.to_owned()))
            .collect()
    }

    // The four statements of the proof before the payload was read through
    // `qualifying` (CQ-MEM), verbatim: each reads `r.payload_json` straight from
    // the table and filters `p`, `s` and `run` with `WHERE` terms. Test oracle only.
    const UNGATED_MALFORMED_SQL: &str = "SELECT EXISTS(
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
         )";

    const UNGATED_MISSING_SQL: &str = "SELECT EXISTS(
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
         )";

    const UNGATED_DUPLICATE_SQL: &str = "SELECT EXISTS(
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
         )";

    const UNGATED_UNEXPECTED_SQL: &str = "SELECT EXISTS(
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
         )";

    /// The proof as it was: the four ungated statements in the order and with the
    /// early exits of [`verify_complete_source_index`].
    fn ungated_proof(conn: &Connection, project: &str) -> rusqlite::Result<bool> {
        for (index, statement) in [
            UNGATED_MALFORMED_SQL,
            UNGATED_MISSING_SQL,
            UNGATED_DUPLICATE_SQL,
            UNGATED_UNEXPECTED_SQL,
        ]
        .into_iter()
        .enumerate()
        {
            let mut arguments = vec![
                project,
                NIR1_ENTITY_RELATION_SET_KIND,
                NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
                NIR1_ENTITY_RELATION_PROPOSAL_KIND,
                NIR1_ENTITY_RELATION_REVISION_ORIGIN,
                ENTITY_RELATION_PRODUCER,
            ];
            if index > 0 {
                arguments.push("proposal-revision");
            }
            let found: bool =
                conn.query_row(statement, rusqlite::params_from_iter(arguments), |row| {
                    row.get(0)
                })?;
            match index {
                3 => return Ok(!found),
                _ if found => return Ok(false),
                _ => {}
            }
        }
        unreachable!("the last statement returns")
    }

    #[test]
    fn registration_proof_parses_the_payload_of_nothing_but_its_subject() {
        let conn = gate_project();
        let calls = record_json_calls(&conn);
        let mut control =
            crate::narrative_extraction::nir1_entity_relation_index::NeverStopGraphWorkControl;

        // Control: without the gate the same statements hand the payload of
        // Revisions that are not subjects to SQLite's JSON functions.
        assert!(ungated_proof(&conn, "project").unwrap());
        let ungated = marked_payloads(&calls);
        let ungated_decoys: Vec<_> = ungated
            .iter()
            .filter(|marker| *marker != "OK")
            .cloned()
            .collect();
        assert!(ungated.contains("OK"));
        assert!(
            ungated_decoys.len() >= 3,
            "the ungated statements parsed only {ungated_decoys:?}; this fixture no longer shows the defect"
        );

        // The proof parses the payload of its subject, and of no other Revision.
        assert!(verify_complete_source_index(&conn, "project", &mut control).unwrap());
        assert_eq!(
            marked_payloads(&calls),
            std::collections::BTreeSet::from(["OK".to_owned()]),
        );

        // The plan computes the set of subjects once, and the statement then starts
        // from it and reaches each Revision by primary key. The only scan of the
        // Revision table is the one that selects the set.
        for statement in [
            SOURCE_INDEX_MALFORMED_SQL,
            SOURCE_INDEX_MISSING_SQL,
            SOURCE_INDEX_DUPLICATE_SQL,
            SOURCE_INDEX_UNEXPECTED_SQL,
        ] {
            let sql = source_index_sql(statement);
            let mut prepared = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let arguments: Vec<&str> = [
                "project",
                NIR1_ENTITY_RELATION_SET_KIND,
                NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
                NIR1_ENTITY_RELATION_PROPOSAL_KIND,
                NIR1_ENTITY_RELATION_REVISION_ORIGIN,
                ENTITY_RELATION_PRODUCER,
                "proposal-revision",
            ]
            .into_iter()
            .take(prepared.parameter_count())
            .collect();
            let plan: Vec<String> = prepared
                .query_map(rusqlite::params_from_iter(arguments), |row| {
                    row.get::<_, String>(3)
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            let position = |line: &str| plan.iter().position(|step| step == line);
            let at = format!("plan:\n{}", plan.join("\n"));
            let materialize = position("MATERIALIZE qualifying").expect(&at);
            let scan_set = position("SCAN q").expect(&at);
            let revision_by_key = position(
                "SEARCH r USING INDEX sqlite_autoindex_narrative_proposal_revisions_1 (id=?)",
            )
            .expect(&at);
            assert_eq!(
                plan.iter()
                    .filter(|step| *step == "MATERIALIZE qualifying")
                    .count(),
                1,
                "{at}"
            );
            assert_eq!(
                plan.iter().filter(|step| *step == "SCAN r").count(),
                1,
                "{at}"
            );
            assert!(materialize < scan_set && scan_set < revision_by_key, "{at}");
        }
    }

    #[test]
    fn gated_proof_agrees_with_the_ungated_proof_on_every_failure_class() {
        let mut control =
            crate::narrative_extraction::nir1_entity_relation_index::NeverStopGraphWorkControl;
        type Break = fn(&Connection);
        let breaks: [(&str, Break); 6] = [
            ("no edge", |conn| {
                conn.execute(
                    "DELETE FROM narrative_dependency_edges
                      WHERE consumer_key = 'rev-ok'",
                    [],
                )
                .unwrap();
            }),
            ("duplicate edge", |conn| {
                insert(
                    conn,
                    "project",
                    "codex:entity",
                    "proposal-revision",
                    "rev-ok",
                );
            }),
            ("unexpected edge", |conn| {
                insert(
                    conn,
                    "project",
                    "codex:other",
                    "proposal-revision",
                    "rev-ok",
                );
            }),
            ("malformed payload", |conn| {
                conn.execute(
                    "UPDATE narrative_proposal_revisions SET payload_json = '{'
                      WHERE id = 'rev-ok'",
                    [],
                )
                .unwrap();
            }),
            ("blank entity id", |conn| {
                conn.execute(
                    "UPDATE narrative_proposal_revisions
                        SET payload_json = replace(payload_json, '\"entityId\":\"entity\"',
                                                   '\"entityId\":\"\"')
                      WHERE id = 'rev-ok'",
                    [],
                )
                .unwrap();
            }),
            ("another project's payload", |conn| {
                conn.execute(
                    "UPDATE narrative_proposal_revisions
                        SET payload_json = replace(payload_json, '\"projectId\":\"project\"',
                                                   '\"projectId\":\"other\"')
                      WHERE id = 'rev-ok'",
                    [],
                )
                .unwrap();
            }),
        ];

        let conn = gate_project();
        assert!(ungated_proof(&conn, "project").unwrap());
        assert!(verify_complete_source_index(&conn, "project", &mut control).unwrap());
        for (name, damage) in breaks {
            let conn = gate_project();
            damage(&conn);
            let ungated = ungated_proof(&conn, "project").unwrap();
            assert!(!ungated, "{name} must fail the proof");
            assert_eq!(
                verify_complete_source_index(&conn, "project", &mut control).unwrap(),
                ungated,
                "{name}"
            );
        }
    }
}
