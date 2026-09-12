//! Request-local NIR-1 entity/relation adapter.
//!
//! The existing Codex catalog and relation tables are used only as a source
//! snapshot.  They are never treated as an immutable NIR revision and the
//! returned graph is never persisted.  This keeps the request-local graph
//! projection fail-closed alongside the dedicated typed Revision writer.
//! The renderer IPC route is intentionally disabled until A3+B+D2a provide
//! the required revision, disclosure, and resource gates.

use grimodex_core::narrative_nir1::{
    bounded_graph, BoundedGraph, EntityInput, EntityRelationBundle, EvidenceInput, GraphEdgeInput,
    GraphLimits, ScopeBinding, ScopeValue, ENTITY_RELATION_PRODUCER,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::retrieval_admission::{
    read_retrieval_query_context, QueryIdentityState, RetrievalQueryContextRead,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Nir1GraphRequest {
    pub project_id: String,
    pub query_scene_id: String,
    pub seed_entity_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1GraphResponse {
    pub status: &'static str,
    pub project_id: String,
    pub query_scene_id: String,
    pub scope_revision: Option<String>,
    pub graph: Option<BoundedGraph>,
    pub reason: Option<String>,
}

/// Read and bound a graph from one authoritative SQLite snapshot.
///
/// The caller owns the read transaction.  Query context is resolved before
/// any catalog rows are exposed, and the seed is an explicit Codex id.  No
/// name matching, renderer-provided Scope, or cross-project relation can
/// create a graph node.
pub fn read_nir1_graph(
    conn: &Connection,
    request: &Nir1GraphRequest,
) -> anyhow::Result<Nir1GraphResponse> {
    if conn.is_autocommit() {
        anyhow::bail!("NIR1_GRAPH_REQUIRES_READ_TRANSACTION");
    }
    if request.project_id.trim().is_empty()
        || request.query_scene_id.trim().is_empty()
        || request.seed_entity_id.trim().is_empty()
    {
        anyhow::bail!("NIR1_GRAPH_INVALID_REQUEST");
    }
    let query =
        match read_retrieval_query_context(conn, &request.project_id, &request.query_scene_id)? {
            RetrievalQueryContextRead::Available(query) => query,
            RetrievalQueryContextRead::Unavailable { reason } => {
                return Ok(unavailable_response(
                    request,
                    format!("query-context:{reason:?}"),
                ))
            }
        };

    let entities = conn
        .prepare(
            "SELECT id, type, name, summary, updated_at
               FROM codex_entries
              WHERE project_id = ?1
                AND context_mode NOT IN ('hidden', 'suppress')
              ORDER BY id ASC
              LIMIT ?2",
        )?
        .query_map(
            params![
                &request.project_id,
                (grimodex_core::narrative_nir1::MAX_GRAPH_RECORDS + 1) as i64
            ],
            |row| {
                let id: String = row.get(0)?;
                let entity_type: String = row.get(1)?;
                let name: String = row.get(2)?;
                let summary: Option<String> = row.get(3)?;
                let updated_at: String = row.get(4)?;
                let text = summary
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(name.clone());
                Ok((
                    EntityInput {
                        entity_id: id.clone(),
                        entity_type,
                        label: name,
                        source_token: format!("codex:{id}@{updated_at}"),
                        scope: scope_from_query(&query),
                        evidence: vec![EvidenceInput {
                            evidence_id: evidence_id(&id),
                            source_ref: format!("codex:{id}"),
                            start_utf16: 0,
                            end_utf16: text.encode_utf16().count(),
                            quote: text,
                        }],
                    },
                    id,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    if entities.len() > grimodex_core::narrative_nir1::MAX_GRAPH_RECORDS {
        return Ok(unavailable_response(request, "catalog-record-limit".into()));
    }

    let relations = conn
        .prepare(
            "SELECT relation.id, relation.from_codex_id, relation.to_codex_id,
                    relation.relation_type, relation.directionality,
                    relation.version, relation.updated_at
               FROM codex_relations relation
              JOIN codex_entries from_entry
                ON from_entry.id = relation.from_codex_id
               AND from_entry.project_id = relation.project_id
               AND from_entry.context_mode NOT IN ('hidden', 'suppress')
              JOIN codex_entries to_entry
                ON to_entry.id = relation.to_codex_id
               AND to_entry.project_id = relation.project_id
               AND to_entry.context_mode NOT IN ('hidden', 'suppress')
              WHERE relation.project_id = ?1
              ORDER BY relation.id ASC
              LIMIT ?2",
        )?
        .query_map(
            params![
                &request.project_id,
                (grimodex_core::narrative_nir1::MAX_GRAPH_RECORDS + 1) as i64
            ],
            |row| {
                let edge_id: String = row.get(0)?;
                let from_entity_id: String = row.get(1)?;
                let to_entity_id: String = row.get(2)?;
                let relation_type: String = row.get(3)?;
                let directionality: String = row.get(4)?;
                let version: i64 = row.get(5)?;
                let updated_at: String = row.get(6)?;
                Ok(GraphEdgeInput {
                    edge_id: edge_id.clone(),
                    from_entity_id: from_entity_id.clone(),
                    to_entity_id: to_entity_id.clone(),
                    relation_type,
                    directionality,
                    source_token: format!("v{version}@{updated_at}:relation:{edge_id}"),
                    evidence_ids: vec![evidence_id(&from_entity_id), evidence_id(&to_entity_id)],
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    if relations.len() > grimodex_core::narrative_nir1::MAX_GRAPH_RECORDS {
        return Ok(unavailable_response(
            request,
            "relation-record-limit".into(),
        ));
    }
    if entities.len().saturating_add(relations.len())
        > grimodex_core::narrative_nir1::MAX_GRAPH_RECORDS
    {
        return Ok(unavailable_response(
            request,
            "combined-record-limit".into(),
        ));
    }

    let bundle = EntityRelationBundle {
        project_id: request.project_id.clone(),
        revision_id: format!("catalog@{}", query.query_source.revision_token),
        producer: ENTITY_RELATION_PRODUCER.into(),
        entities: entities.into_iter().map(|(entity, _)| entity).collect(),
        relations,
    };
    let graph = match bounded_graph(&bundle, &request.seed_entity_id, GraphLimits::default()) {
        Ok(graph) => graph,
        Err(error) => return Ok(unavailable_response(request, error.to_string())),
    };
    Ok(Nir1GraphResponse {
        status: "available",
        project_id: request.project_id.clone(),
        query_scene_id: request.query_scene_id.clone(),
        scope_revision: Some(query.scope_authority_revision_token),
        graph: Some(graph),
        reason: None,
    })
}

fn evidence_id(entity_id: &str) -> String {
    format!("nir1:evidence:{entity_id}")
}

fn scope_from_query(query: &super::retrieval_admission::RetrievalQueryContext) -> ScopeBinding {
    ScopeBinding {
        reading: ScopeValue::Exact {
            value: query.query_scene_ref.clone(),
        },
        // The initial reader-reference profile does not authorize these axes;
        // preserve NotApplicable/Unavailable instead of inferring from POV.
        story: scope_value_from_identity(&query.story_time),
        auto: ScopeValue::NotApplicable {
            reason: "initial-reader-profile".into(),
        },
        phase: query.phase_resolution_mode.clone(),
        reveal: "reader".into(),
        pov: match &query.viewpoint {
            QueryIdentityState::Resolved(value) => Some(value.clone()),
            QueryIdentityState::NotApplicable { .. } | QueryIdentityState::Unavailable { .. } => {
                None
            }
        },
        authority_revision: query.scope_authority_revision_token.clone(),
    }
}

fn scope_value_from_identity(identity: &QueryIdentityState) -> ScopeValue {
    match identity {
        QueryIdentityState::Resolved(value) => ScopeValue::Exact {
            value: value.clone(),
        },
        QueryIdentityState::NotApplicable { reason } => ScopeValue::NotApplicable {
            reason: (*reason).into(),
        },
        QueryIdentityState::Unavailable { reason } => ScopeValue::Unavailable {
            reason: (*reason).into(),
        },
    }
}

fn unavailable_response(request: &Nir1GraphRequest, reason: String) -> Nir1GraphResponse {
    Nir1GraphResponse {
        status: "unavailable",
        project_id: request.project_id.clone(),
        query_scene_id: request.query_scene_id.clone(),
        scope_revision: None,
        graph: None,
        reason: Some(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::{read_nir1_graph, Nir1GraphRequest};
    use crate::test_support::fresh_migrated_memory;

    fn seed_graph(db: &crate::Database) -> anyhow::Result<()> {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, content, sort_order)
                 VALUES ('nir1-scene', 'default-project', 'scene', 'Scene', '{}', 'a0')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary)
                 VALUES ('nir1-alice', 'default-project', 'character', 'Alice', 'Alice enters')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary)
                 VALUES ('nir1-bob', 'default-project', 'character', 'Bob', 'Bob waits')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_relations
                    (id, project_id, from_codex_id, to_codex_id, relation_type,
                     directionality, updated_at)
                 VALUES ('nir1-edge', 'default-project', 'nir1-alice', 'nir1-bob',
                         'knows', 'directed', '2026-09-12T00:00:00Z')",
                [],
            )?;
            Ok(())
        })
    }

    #[test]
    fn graph_reader_uses_one_read_snapshot_and_preserves_explicit_seed() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_graph(&db)?;
        let response = db.with_read_transaction(|conn| {
            read_nir1_graph(
                conn,
                &Nir1GraphRequest {
                    project_id: "default-project".into(),
                    query_scene_id: "nir1-scene".into(),
                    seed_entity_id: "nir1-alice".into(),
                },
            )
        })?;
        assert_eq!(response.status, "available");
        let graph = response.graph.expect("bounded graph");
        assert_eq!(graph.seed_entity_id, "nir1-alice");
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.edges.len(), 1);
        assert!(response
            .scope_revision
            .as_deref()
            .is_some_and(|value| value.starts_with("sha256:")));
        Ok(())
    }

    #[test]
    fn graph_reader_rejects_an_autocommit_connection() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        let result = db.with_conn(|conn| {
            read_nir1_graph(
                conn,
                &Nir1GraphRequest {
                    project_id: "default-project".into(),
                    query_scene_id: "nir1-scene".into(),
                    seed_entity_id: "nir1-alice".into(),
                },
            )
        });
        assert!(result
            .expect_err("autocommit must be rejected")
            .to_string()
            .contains("NIR1_GRAPH_REQUIRES_READ_TRANSACTION"));
        Ok(())
    }

    #[test]
    fn graph_reader_drops_relations_to_hidden_or_suppressed_entities() -> anyhow::Result<()> {
        for context_mode in ["hidden", "suppress"] {
            let db = fresh_migrated_memory()?;
            seed_graph(&db)?;
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO codex_entries (id, project_id, type, name, summary)
                     VALUES ('nir1-unrelated-from', 'default-project', 'character',
                             'Unrelated from', 'Unrelated from')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO codex_entries (id, project_id, type, name, summary)
                     VALUES ('nir1-unrelated-to', 'default-project', 'character',
                             'Unrelated to', 'Unrelated to')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO codex_relations
                        (id, project_id, from_codex_id, to_codex_id, relation_type,
                         directionality, updated_at)
                     VALUES ('nir1-unrelated-edge', 'default-project',
                             'nir1-unrelated-from', 'nir1-unrelated-to',
                             'knows', 'directed', '2026-09-12T00:00:00Z')",
                    [],
                )?;
                conn.execute(
                    "UPDATE codex_entries SET context_mode = ?1
                       WHERE id = 'nir1-unrelated-to'",
                    [context_mode],
                )?;
                Ok(())
            })?;

            let response = db.with_read_transaction(|conn| {
                read_nir1_graph(
                    conn,
                    &Nir1GraphRequest {
                        project_id: "default-project".into(),
                        query_scene_id: "nir1-scene".into(),
                        seed_entity_id: "nir1-alice".into(),
                    },
                )
            })?;
            assert_eq!(response.status, "available", "context mode: {context_mode}");
            let graph = response.graph.expect("seed graph remains available");
            assert_eq!(graph.nodes.len(), 2, "context mode: {context_mode}");
            assert_eq!(graph.edges.len(), 1, "context mode: {context_mode}");
            assert_eq!(graph.edges[0].edge_id, "nir1-edge");
        }
        Ok(())
    }
}
