//! Computed live project Scope/Order authority.
//!
//! The durable authority remains `tree_nodes`; this module owns no table or
//! mutable head. It reads one SQLite snapshot, derives the live Scene list in
//! persisted Reading DFS order, and delegates the three typed axis projections
//! and aggregate revision token to Core.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use grimodex_core::narrative_project_scope_authority::{
    build_narrative_project_scope_authority_v1, NarrativeProjectScopeAuthoritySceneInputV1,
    NarrativeProjectScopeAuthorityV1,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

const PROJECT_SCOPE_AUTHORITY_SOURCE_PREFIX: &str = "project:scope-authority:";
const PROJECT_SCOPE_AUTHORITY_SNAPSHOT: &str = "narrative_project_scope_authority_snapshot";

#[derive(Debug)]
struct PersistedProjectTreeNode {
    id: String,
    parent_id: Option<String>,
    node_type: String,
    sort_order: String,
    story_time_order: Option<String>,
    archived_at: Option<String>,
    version: i64,
    updated_at: String,
    archived: bool,
}

enum Traversal {
    Enter(usize),
    Exit(usize),
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn invalid_tree(reason: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("NEX_PROJECT_SCOPE_AUTHORITY_TREE_INVALID: {reason}")
}

fn sort_siblings(
    indices: &mut [usize],
    nodes: &[PersistedProjectTreeNode],
    owner: &str,
) -> anyhow::Result<()> {
    indices.sort_by(|left, right| {
        compare_utf16(&nodes[*left].sort_order, &nodes[*right].sort_order)
            .then_with(|| compare_utf16(&nodes[*left].id, &nodes[*right].id))
    });
    for pair in indices.windows(2) {
        anyhow::ensure!(
            compare_utf16(&nodes[pair[0]].sort_order, &nodes[pair[1]].sort_order)
                != Ordering::Equal,
            "NEX_PROJECT_SCOPE_AUTHORITY_TREE_INVALID: duplicate persisted sortOrder under {owner}"
        );
    }
    Ok(())
}

fn has_archived_ancestor(
    start: usize,
    nodes: &[PersistedProjectTreeNode],
    node_by_id: &HashMap<&str, usize>,
) -> anyhow::Result<bool> {
    let mut current = start;
    let mut seen = HashSet::new();
    loop {
        anyhow::ensure!(
            seen.insert(current),
            "NEX_PROJECT_SCOPE_AUTHORITY_TREE_INVALID: active tree contains a parent cycle"
        );
        let Some(parent_id) = nodes[current].parent_id.as_deref() else {
            return Ok(false);
        };
        let parent = node_by_id.get(parent_id).copied().ok_or_else(|| {
            invalid_tree(format!(
                "node '{}' has a missing or cross-project parent '{parent_id}'",
                nodes[current].id
            ))
        })?;
        if nodes[parent].archived {
            return Ok(true);
        }
        current = parent;
    }
}

fn derive_live_scene_projection(
    nodes: &[PersistedProjectTreeNode],
) -> anyhow::Result<Vec<NarrativeProjectScopeAuthoritySceneInputV1>> {
    let node_by_id = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut roots = Vec::new();
    let mut children_by_parent = HashMap::<&str, Vec<usize>>::new();
    for (index, node) in nodes.iter().enumerate() {
        if node.archived {
            continue;
        }
        match node.parent_id.as_deref() {
            Some(parent_id) => children_by_parent.entry(parent_id).or_default().push(index),
            None => roots.push(index),
        }
    }
    sort_siblings(&mut roots, nodes, "the project root")?;
    let mut traversal = Vec::with_capacity(roots.len());
    for root in roots.iter().rev() {
        traversal.push(Traversal::Enter(*root));
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    let mut scenes = Vec::new();
    while let Some(frame) = traversal.pop() {
        match frame {
            Traversal::Exit(index) => {
                visiting.remove(&index);
                visited.insert(index);
            }
            Traversal::Enter(index) => {
                anyhow::ensure!(
                    visiting.insert(index),
                    "NEX_PROJECT_SCOPE_AUTHORITY_TREE_INVALID: live tree contains a cycle"
                );
                anyhow::ensure!(
                    !visited.contains(&index),
                    "NEX_PROJECT_SCOPE_AUTHORITY_TREE_INVALID: live node is reachable more than once"
                );
                let node = &nodes[index];
                let mut children = children_by_parent
                    .get(node.id.as_str())
                    .cloned()
                    .unwrap_or_default();
                sort_siblings(&mut children, nodes, &format!("parent '{}'", node.id))?;
                if node.node_type != "folder" {
                    anyhow::ensure!(
                        children.is_empty(),
                        "NEX_PROJECT_SCOPE_AUTHORITY_TREE_INVALID: non-folder node '{}' owns live children",
                        node.id
                    );
                }
                traversal.push(Traversal::Exit(index));
                match node.node_type.as_str() {
                    "scene" => scenes.push(NarrativeProjectScopeAuthoritySceneInputV1 {
                        scene_id: node.id.clone(),
                        raw_story_key: node.story_time_order.clone(),
                    }),
                    "note" => {}
                    "folder" => {
                        for child in children.iter().rev() {
                            traversal.push(Traversal::Enter(*child));
                        }
                    }
                    other => {
                        return Err(invalid_tree(format!(
                            "live node '{}' has unsupported nodeType '{other}'",
                            node.id
                        )))
                    }
                }
            }
        }
    }

    // A non-archived row not reached from an active root is legitimate only
    // when an archived ancestor cuts off that whole subtree. Orphans,
    // cross-project parents, and active cycles fail closed.
    for (index, node) in nodes.iter().enumerate() {
        if node.archived || visited.contains(&index) {
            continue;
        }
        anyhow::ensure!(
            has_archived_ancestor(index, nodes, &node_by_id)?,
            "NEX_PROJECT_SCOPE_AUTHORITY_TREE_INVALID: active node '{}' is unreachable from the project root",
            node.id
        );
    }
    Ok(scenes)
}

fn canonical_tree_source_generation(
    project_id: &str,
    nodes: &[PersistedProjectTreeNode],
) -> anyhow::Result<String> {
    let rows = nodes
        .iter()
        .map(|node| {
            json!({
                "id": node.id,
                "parentId": node.parent_id,
                "nodeType": node.node_type,
                "sortOrder": node.sort_order,
                "storyTimeOrder": node.story_time_order,
                "archivedAt": node.archived_at,
                "version": node.version,
                "updatedAt": node.updated_at,
            })
        })
        .collect::<Vec<_>>();
    Ok(grimodex_core::canonical_json_digest(&json!({
        "contractId": "narrative-tree-source-generation/1",
        "projectId": project_id,
        "nodes": rows,
    }))?)
}

fn load_live_project_scope_authority_in_snapshot(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<NarrativeProjectScopeAuthorityV1> {
    let project_exists = conn
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(
        project_exists,
        "NEX_SOURCE_MISSING: project '{project_id}' was not found"
    );

    let mut statement = conn.prepare(
        "SELECT id, parent_id, node_type, sort_order, story_time_order,
                archived_at, version, updated_at
           FROM tree_nodes
          WHERE project_id = ?1
          ORDER BY id",
    )?;
    let nodes = statement
        .query_map(params![project_id], |row| {
            Ok(PersistedProjectTreeNode {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                node_type: row.get(2)?,
                sort_order: row.get(3)?,
                story_time_order: row.get(4)?,
                archived_at: row.get(5)?,
                version: row.get(6)?,
                updated_at: row.get(7)?,
                archived: row.get::<_, Option<String>>(5)?.is_some(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let tree_source_generation = canonical_tree_source_generation(project_id, &nodes)?;
    let scenes = derive_live_scene_projection(&nodes)?;
    let mut authority = build_narrative_project_scope_authority_v1(project_id, &scenes)?;
    if let Some(extension_digest) =
        super::scope_extension_digest(conn, project_id, &tree_source_generation)?
    {
        authority.source.revision_token =
            grimodex_core::canonical_json_digest(&serde_json::json!({
                "baseRevisionToken": authority.source.revision_token,
                "sceneScopeExtensionDigest": extension_digest,
            }))?;
    }
    Ok(authority)
}

/// Resolve the computed live authority under exactly one SQLite SAVEPOINT.
/// SAVEPOINT is safe both in autocommit mode and inside an existing caller
/// transaction; this function never opens a nested `BEGIN`.
pub(crate) fn load_live_project_scope_authority(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<NarrativeProjectScopeAuthorityV1> {
    anyhow::ensure!(
        !project_id.is_empty() && project_id.trim() == project_id,
        "NEX_SOURCE_PROJECT_INVALID: projectId must be trimmed and non-empty"
    );
    let source_project_id = source_key
        .strip_prefix(PROJECT_SCOPE_AUTHORITY_SOURCE_PREFIX)
        .filter(|value| !value.is_empty() && value.trim() == *value)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SOURCE_KEY_INVALID: project-scope-authority sourceKey must be project:scope-authority:<projectId>"
            )
        })?;
    anyhow::ensure!(
        source_project_id == project_id,
        "NEX_SOURCE_PROJECT_MISMATCH: project Scope authority does not belong to project"
    );

    conn.execute_batch(&format!("SAVEPOINT {PROJECT_SCOPE_AUTHORITY_SNAPSHOT}"))?;
    let result = load_live_project_scope_authority_in_snapshot(conn, project_id);
    match result {
        Ok(authority) => {
            conn.execute_batch(&format!("RELEASE {PROJECT_SCOPE_AUTHORITY_SNAPSHOT}"))?;
            Ok(authority)
        }
        Err(error) => {
            let _ = conn.execute_batch(&format!(
                "ROLLBACK TO {PROJECT_SCOPE_AUTHORITY_SNAPSHOT}; RELEASE {PROJECT_SCOPE_AUTHORITY_SNAPSHOT};"
            ));
            Err(error)
        }
    }
}
