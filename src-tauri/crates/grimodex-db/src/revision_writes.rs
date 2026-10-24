//! Typed Native writers for the version history (`content_versions`, a
//! `read-open` table) and the project snapshot deletion (NIR-1 DA-2b M,
//! K3/2 "M と T の対処の規則" 1; DR-DA2-51).
//!
//! Restricted generic SQL may read `content_versions` but never mutate it, and
//! deleting a `project_snapshots` row cascades into the `read-open` snapshot
//! child tables, so these three writes are typed. The rules are the
//! renderer's current ones (`createRevision`, `pruneRevisions`,
//! `deleteProjectSnapshot`), kept in one transaction each. The writers return
//! ids, numbers, times and counts only; a version body is never returned.

use std::fmt;

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::Database;

pub const REVISION_WRITE_REFUSED: &str = "REVISION_WRITE_REFUSED";
pub const PROJECT_SNAPSHOT_WRITE_REFUSED: &str = "PROJECT_SNAPSHOT_WRITE_REFUSED";

pub const MAX_ID_CHARS: usize = 256;
pub const MAX_KEEP_COUNT: i64 = 100_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RevisionWriteRefusal {
    InvalidRequest,
    NotFound,
}

impl RevisionWriteRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid-request",
            Self::NotFound => "not-found",
        }
    }
}

impl fmt::Display for RevisionWriteRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{REVISION_WRITE_REFUSED}:{}", self.code())
    }
}

impl std::error::Error for RevisionWriteRefusal {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProjectSnapshotWriteRefusal;

impl fmt::Display for ProjectSnapshotWriteRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{PROJECT_SNAPSHOT_WRITE_REFUSED}:invalid-request")
    }
}

impl std::error::Error for ProjectSnapshotWriteRefusal {}

fn refuse<T>(refusal: RevisionWriteRefusal) -> Result<T> {
    Err(anyhow::Error::new(refusal))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= MAX_ID_CHARS
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RevisionEntityType {
    Scene,
    Note,
    CodexEntry,
    Snippet,
}

impl RevisionEntityType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Scene => "scene",
            Self::Note => "note",
            Self::CodexEntry => "codex_entry",
            Self::Snippet => "snippet",
        }
    }

    /// Whether the entity row exists in `project_id`.
    fn owned_by(self, conn: &Connection, project_id: &str, entity_id: &str) -> Result<bool> {
        // The editor records a manual version as `scene` for any tree
        // binding (a note included), so `scene` and `note` both mean a
        // `tree_nodes` row of the project, as the renderer always wrote.
        let sql = match self {
            Self::Scene | Self::Note => {
                "SELECT EXISTS (SELECT 1 FROM tree_nodes WHERE id = ?1 AND project_id = ?2)"
            }
            Self::CodexEntry => {
                "SELECT EXISTS (SELECT 1 FROM codex_entries WHERE id = ?1 AND project_id = ?2)"
            }
            Self::Snippet => {
                "SELECT EXISTS (SELECT 1 FROM snippets WHERE id = ?1 AND project_id = ?2)"
            }
        };
        Ok(conn.query_row(sql, params![entity_id, project_id], |row| row.get(0))?)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RevisionSnapshotType {
    Auto,
    Manual,
}

impl RevisionSnapshotType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRevisionRequest {
    pub project_id: String,
    pub entity_type: RevisionEntityType,
    pub entity_id: String,
    pub content: String,
    pub snapshot_type: RevisionSnapshotType,
}

/// `created: false` names the latest version, whose body equals the request.
#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRevision {
    pub created: bool,
    pub id: String,
    pub version_number: i64,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PruneRevisionsRequest {
    pub project_id: String,
    pub entity_type: RevisionEntityType,
    pub entity_id: String,
    pub keep_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteProjectSnapshotRequest {
    pub project_id: String,
    pub snapshot_id: String,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub struct DeletedCount {
    pub deleted: usize,
}

pub(crate) fn with_immediate_transaction<T>(
    db: &Database,
    operation: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        match operation(conn) {
            Ok(value) => match conn.execute_batch("COMMIT") {
                Ok(()) => Ok(value),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error.into())
                }
            },
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Record a version unless the latest version already has this exact body
/// (`createRevision`). The number is `max + 1` inside the same transaction.
pub fn create_revision(db: &Database, request: CreateRevisionRequest) -> Result<CreatedRevision> {
    if !valid_id(&request.project_id) || !valid_id(&request.entity_id) {
        return refuse(RevisionWriteRefusal::InvalidRequest);
    }
    let entity_type = request.entity_type.as_str();
    with_immediate_transaction(db, |conn| {
        if !request
            .entity_type
            .owned_by(conn, &request.project_id, &request.entity_id)?
        {
            return refuse(RevisionWriteRefusal::NotFound);
        }
        let latest: Option<(String, i64, String, String)> = conn
            .query_row(
                "SELECT id, version_number, created_at, content
                   FROM content_versions
                  WHERE entity_type = ?1 AND entity_id = ?2
                  ORDER BY version_number DESC
                  LIMIT 1",
                params![entity_type, request.entity_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((id, version_number, created_at, content)) = latest.as_ref() {
            if *content == request.content {
                return Ok(CreatedRevision {
                    created: false,
                    id: id.clone(),
                    version_number: *version_number,
                    created_at: created_at.clone(),
                });
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = now_iso();
        let version_number = latest.as_ref().map_or(0, |(_, number, _, _)| *number) + 1;
        conn.execute(
            "INSERT INTO content_versions
                (id, entity_type, entity_id, content, version_number, snapshot_type, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                entity_type,
                request.entity_id,
                request.content,
                version_number,
                request.snapshot_type.as_str(),
                created_at,
            ],
        )?;
        Ok(CreatedRevision {
            created: true,
            id,
            version_number,
            created_at,
        })
    })
}

/// Keep the newest `keep_count` versions; of the older ones delete the
/// `auto` versions that no snapshot references (`pruneRevisions`).
pub fn prune_revisions(db: &Database, request: PruneRevisionsRequest) -> Result<DeletedCount> {
    if !valid_id(&request.project_id)
        || !valid_id(&request.entity_id)
        || !(0..=MAX_KEEP_COUNT).contains(&request.keep_count)
    {
        return refuse(RevisionWriteRefusal::InvalidRequest);
    }
    let entity_type = request.entity_type.as_str();
    with_immediate_transaction(db, |conn| {
        if !request
            .entity_type
            .owned_by(conn, &request.project_id, &request.entity_id)?
        {
            return refuse(RevisionWriteRefusal::NotFound);
        }
        let deleted = conn.execute(
            "DELETE FROM content_versions
              WHERE id IN (
                SELECT candidate.id
                  FROM (SELECT id, snapshot_type
                          FROM content_versions
                         WHERE entity_type = ?1 AND entity_id = ?2
                         ORDER BY version_number DESC
                         LIMIT -1 OFFSET ?3) AS candidate
                 WHERE candidate.snapshot_type = 'auto'
                   AND NOT EXISTS (SELECT 1 FROM project_snapshot_entries
                                    WHERE version_id = candidate.id)
                   AND NOT EXISTS (SELECT 1 FROM project_snapshot_tree_nodes
                                    WHERE body_version_id = candidate.id)
                   AND NOT EXISTS (SELECT 1 FROM project_snapshot_codex_entries
                                    WHERE body_version_id = candidate.id)
                   AND NOT EXISTS (SELECT 1 FROM project_snapshot_snippets
                                    WHERE body_version_id = candidate.id)
              )",
            params![entity_type, request.entity_id, request.keep_count],
        )?;
        Ok(DeletedCount { deleted })
    })
}

/// Delete one snapshot of `project_id`. Its child rows follow the existing
/// foreign keys; the referenced `content_versions` rows stay.
pub fn delete_project_snapshot(
    db: &Database,
    request: DeleteProjectSnapshotRequest,
) -> Result<DeletedCount> {
    if !valid_id(&request.project_id) || !valid_id(&request.snapshot_id) {
        return Err(anyhow::Error::new(ProjectSnapshotWriteRefusal));
    }
    with_immediate_transaction(db, |conn| {
        let deleted = conn.execute(
            "DELETE FROM project_snapshots WHERE id = ?1 AND project_id = ?2",
            params![request.snapshot_id, request.project_id],
        )?;
        Ok(DeletedCount { deleted })
    })
}
