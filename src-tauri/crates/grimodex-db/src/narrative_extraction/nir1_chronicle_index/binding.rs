use anyhow::Result;
use grimodex_core::narrative_dependency::DependencyRole;
use rusqlite::{params, Connection, OptionalExtension};

use super::super::declaration_storage::{
    read_active_dependency_declaration_set_in_tx, ActiveDependencyDeclarationSetRead,
};
use super::{INDEX_KEY, PRODUCER_ID, PRODUCER_VERSION};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct StoredBinding {
    pub generation: i64,
    pub source_digest: String,
    pub dependency_set_digest: String,
    pub dirty: bool,
    pub declaration_set_id: String,
    pub head_version: i64,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum BindingRead {
    Missing,
    Registered(StoredBinding),
    Reserved,
}

/// Registration is a durable producer binding, never a live query proof.
/// A dirty or cold registered index remains rebuildable by its own producer.
pub(super) fn read(conn: &Connection, project: &str) -> Result<BindingRead> {
    let row = conn.query_row(
        "SELECT generation,source_digest,dependency_set_digest,dirty_cache_flag,producer_id,producer_version
         FROM narrative_semantic_index_metadata WHERE project_id=?1 AND index_key=?2",
        params![project,INDEX_KEY], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,Option<String>>(1)?,
            r.get::<_,Option<String>>(2)?,r.get::<_,i64>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?)),
    ).optional()?;
    let declaration =
        read_active_dependency_declaration_set_in_tx(conn, project, "semantic-index", INDEX_KEY)?;
    let Some((generation, source_digest, dependency_digest, dirty, producer, version)) = row else {
        let residue: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM narrative_dependency_edges WHERE project_id=?1 AND consumer_kind='semantic-index' AND consumer_key=?2)
             OR EXISTS(SELECT 1 FROM narrative_consumer_freshness WHERE project_id=?1 AND consumer_kind='semantic-index' AND consumer_key=?2)
             OR EXISTS(SELECT 1 FROM narrative_nir1_chronicle_vectors WHERE project_id=?1)",
            params![project,INDEX_KEY],|r|r.get(0))?;
        return Ok(
            if !residue && declaration == ActiveDependencyDeclarationSetRead::Missing {
                BindingRead::Missing
            } else {
                BindingRead::Reserved
            },
        );
    };
    let ActiveDependencyDeclarationSetRead::Active(declaration) = declaration else {
        return Ok(BindingRead::Reserved);
    };
    let (Some(source_digest), Some(dependency_set_digest)) = (source_digest, dependency_digest)
    else {
        return Ok(BindingRead::Reserved);
    };
    if generation <= 0
        || !matches!(dirty, 0 | 1)
        || !is_digest(&source_digest)
        || producer.as_deref() != Some(PRODUCER_ID)
        || version.as_deref() != Some(PRODUCER_VERSION)
        || declaration.producer_id != PRODUCER_ID
        || declaration.producer_generation != generation
        || declaration.dependency_set_digest != dependency_set_digest
        || declaration.entries.is_empty()
    {
        return Ok(BindingRead::Reserved);
    }
    let head_version: i64 = conn.query_row(
        "SELECT version FROM narrative_dependency_declaration_heads WHERE project_id=?1 AND consumer_kind='semantic-index' AND consumer_key=?2",
        params![project,INDEX_KEY],|r|r.get(0))?;
    if head_version <= 0 {
        return Ok(BindingRead::Reserved);
    }
    let edges = super::super::dependency_edges::find_edges_by_consumer(
        conn,
        project,
        "semantic-index",
        INDEX_KEY,
    )?;
    let source_key = super::source::source_key(project);
    if edges.len() != declaration.entries.len()
        || declaration.entries.iter().any(|entry| {
            entry.dependency_role != DependencyRole::RankingOnly
                || entry.selector_json != "{\"kind\":\"whole-source\"}"
                || !edges
                    .iter()
                    .any(|edge| edge.source_object_identity == entry.source_object_identity)
        })
        || !declaration
            .entries
            .iter()
            .any(|entry| entry.source_object_identity == source_key)
    {
        return Ok(BindingRead::Reserved);
    }
    for edge in &edges {
        let Ok(tokens) = serde_json::from_str::<Vec<String>>(&edge.read_set_json) else {
            return Ok(BindingRead::Reserved);
        };
        if tokens.len() != 1
            || tokens[0].is_empty()
            || (edge.source_object_identity == source_key
                && (tokens[0] != source_digest || edge.owning_run_id.is_some()))
        {
            return Ok(BindingRead::Reserved);
        }
    }
    Ok(BindingRead::Registered(StoredBinding {
        generation,
        source_digest,
        dependency_set_digest,
        dirty: dirty == 1,
        declaration_set_id: declaration.declaration_set_id,
        head_version,
    }))
}

pub(crate) fn is_registered(conn: &Connection, project: &str, key: &str) -> Result<bool> {
    if conn.is_autocommit() {
        let tx = conn.unchecked_transaction()?;
        return is_registered(&tx, project, key);
    }
    if conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))? < 35 {
        return Ok(false);
    }
    Ok(key == INDEX_KEY && matches!(read(conn, project)?, BindingRead::Registered(_)))
}

/// Verification/restore classification includes the complete canonical row.
/// Stale/dirty/cold is rebuildable; an incoherent producer binding is reserved.
pub(crate) fn is_complete_registered(conn: &Connection, project: &str, key: &str) -> Result<bool> {
    if conn.is_autocommit() {
        let tx = conn.unchecked_transaction()?;
        return is_complete_registered(&tx, project, key);
    }
    if !is_registered(conn, project, key)? {
        return Ok(false);
    }
    let row = conn.query_row("SELECT f.evidence_freshness,f.build_action,f.semantic_epoch_id,f.dependency_set_digest,f.updated_at,m.built_at
        FROM narrative_consumer_freshness f JOIN narrative_semantic_index_metadata m ON m.project_id=f.project_id AND m.index_key=f.consumer_key
        WHERE f.project_id=?1 AND f.consumer_kind='semantic-index' AND f.consumer_key=?2",params![project,key],
        |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?))).optional()?;
    let Some((freshness, action, epoch, digest, updated, built)) = row else {
        return Ok(false);
    };
    Ok(
        super::super::evaluator::EvidenceFreshness::try_from(freshness.as_str()).is_ok()
            && super::super::evaluator::BuildAction::try_from(action.as_str()).is_ok()
            && !epoch.trim().is_empty()
            && super::canonical::canonical_instant(&updated)
            && super::canonical::canonical_instant(&built)
            && digest.as_deref()
                == Some(
                    &super::super::dependency_edges::consumer_dependency_set_digest(
                        conn,
                        project,
                        "semantic-index",
                        key,
                    )?,
                ),
    )
}

pub(super) fn is_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
