//! Native storage of an author's whole-body disclosure declaration (Scene
//! Scope v2, `nir1-c-body-disclosure-proposal/4` `scope-storage-authority`).
//!
//! The declaration lives in two nullable columns of the Scene's existing scope
//! binding row (`body_declaration_json`, `body_declaration_token`). This
//! module owns, for CB-1:
//!
//! - the reader (`None` / `Declared` / `Unavailable(reason)`), which checks
//!   the cell sizes before any text is read into memory;
//! - the clear (both columns to NULL, one `UPDATE`), which returns the feed
//!   events that announce the change;
//! - the feed object kind `scene-body-declaration`, its snapshot and event;
//! - the pure binding-match function a reader uses to tell a declaration
//!   whose Scene changed from one that still holds.
//!
//! Nothing in this file sets the columns. The one production statement that
//! does is in the child module `writer` (CB-2): the declaration writer, which
//! runs only after Main's confirmation was consumed and exists only in the
//! Electron Native build (`native-current-human-capture`). The child modules
//! `veto`, `display`, `facts`, `writer`, `revoke` and `commit_outcome` hold
//! the preview, the shared veto, the confirmation text, the declaration and
//! revoke writers and the handling of a COMMIT whose outcome is unknown. The
//! clear, the setter and the revoke never write any other column of the row
//! (`version`, `source_token`, `updated_at`, the A1 columns) or any other
//! table except the feed and the idempotency ledger, so the v1 Scene Scope
//! token and the project's Scope authority digest stay byte identical.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use grimodex_core::narrative_scene_body_declaration::{
    NarrativeSceneBodyDeclarationParseError, NarrativeSceneBodyDeclarationV1,
    NarrativeSceneBodySourceV1, MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES,
    MAX_NARRATIVE_SCENE_BODY_DECLARATION_TOKEN_BYTES,
};

use super::change_feed::{narrative_snapshot_digest, NarrativeChangeEventInput};

/// Feed object kind of a declaration change. Its key is `sceneId`. It is
/// neither `scene-scope` nor `scope-registry`: a declaration is not a change
/// of the project's Scope authority and has no Source.
pub const SCENE_BODY_DECLARATION_OBJECT_KIND: &str = "scene-body-declaration";
const SNAPSHOT_CONTRACT_ID: &str = "narrative-scene-body-declaration-snapshot/1";
const CHANGED_PATH: &str = "/declaration";

/// Why a stored declaration is unusable. A closed set that names no target.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SceneBodyDeclarationUnavailableReason {
    /// The Scene has no binding row (or is not a Scene of the project).
    BindingRowMissing,
    /// Only one of the two columns is set.
    HalfState,
    /// A cell is larger than its limit; it was not read.
    Oversized,
    /// A cell is not text.
    Malformed,
    /// The declaration names another version.
    UnsupportedVersion,
    /// The declaration has a field the v1 type does not define.
    UnknownField,
    /// The stored token is not the token of the stored declaration.
    TokenMismatch,
    /// The declaration names another project or Scene than its row.
    SceneKeyMismatch,
}

impl SceneBodyDeclarationUnavailableReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::BindingRowMissing => "binding-row-missing",
            Self::HalfState => "half-state",
            Self::Oversized => "oversized",
            Self::Malformed => "malformed",
            Self::UnsupportedVersion => "unsupported-version",
            Self::UnknownField => "unknown-field",
            Self::TokenMismatch => "token-mismatch",
            Self::SceneKeyMismatch => "scene-key-mismatch",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredSceneBodyDeclaration {
    pub declaration: NarrativeSceneBodyDeclarationV1,
    /// The stored token, verified equal to the declaration's own token.
    pub token: String,
}

// The declared variant is large, but a read is short-lived and returned by
// value once per Scene; boxing it would only add an allocation per read.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SceneBodyDeclarationRead {
    /// Both columns are NULL.
    None,
    Declared(StoredSceneBodyDeclaration),
    Unavailable(SceneBodyDeclarationUnavailableReason),
}

// Counts the reads that fetch cell content, so a test can show that a cell
// above its limit is rejected without being read.
#[cfg(test)]
thread_local! {
    pub(crate) static CONTENT_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

struct CellShape {
    storage_type: String,
    octet_length: Option<i64>,
}

impl CellShape {
    fn is_null(&self) -> bool {
        self.storage_type == "null"
    }

    fn is_text(&self) -> bool {
        self.storage_type == "text"
    }

    fn within(&self, limit: usize) -> bool {
        self.octet_length
            .and_then(|length| usize::try_from(length).ok())
            .is_some_and(|length| length <= limit)
    }
}

/// Reads a Scene's declaration. Cell sizes are measured with `octet_length`
/// first; a cell above its limit is never read. Storage errors propagate; every
/// other problem with the stored state is a closed `Unavailable` reason.
pub fn read_scene_body_declaration(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> Result<SceneBodyDeclarationRead> {
    use SceneBodyDeclarationRead::{Declared, Unavailable};
    use SceneBodyDeclarationUnavailableReason as Reason;

    let shapes = conn
        .query_row(
            "SELECT typeof(b.body_declaration_json),
                    octet_length(b.body_declaration_json),
                    typeof(b.body_declaration_token),
                    octet_length(b.body_declaration_token)
               FROM narrative_scene_scope_bindings b
               JOIN tree_nodes s
                 ON s.id = b.scene_id AND s.project_id = b.project_id
                AND s.node_type = 'scene'
              WHERE b.project_id = ?1 AND b.scene_id = ?2",
            params![project_id, scene_id],
            |row| {
                Ok((
                    CellShape {
                        storage_type: row.get(0)?,
                        octet_length: row.get(1)?,
                    },
                    CellShape {
                        storage_type: row.get(2)?,
                        octet_length: row.get(3)?,
                    },
                ))
            },
        )
        .optional()?;
    let Some((json_cell, token_cell)) = shapes else {
        return Ok(Unavailable(Reason::BindingRowMissing));
    };
    match (json_cell.is_null(), token_cell.is_null()) {
        (true, true) => return Ok(SceneBodyDeclarationRead::None),
        (false, false) => {}
        _ => return Ok(Unavailable(Reason::HalfState)),
    }
    if !json_cell.is_text() || !token_cell.is_text() {
        return Ok(Unavailable(Reason::Malformed));
    }
    if !json_cell.within(MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES)
        || !token_cell.within(MAX_NARRATIVE_SCENE_BODY_DECLARATION_TOKEN_BYTES)
    {
        return Ok(Unavailable(Reason::Oversized));
    }
    #[cfg(test)]
    CONTENT_READS.with(|reads| reads.set(reads.get() + 1));
    // The cells are text by `typeof`, but SQLite does not promise valid UTF-8
    // (an external edit or damage can leave any bytes in a text cell, and a
    // `String` read would fail the whole read). Read the raw bytes and decide
    // here: an invalid cell is `Malformed`, never a storage error.
    let (json_bytes, token_bytes): (Vec<u8>, Vec<u8>) = conn.query_row(
        "SELECT CAST(body_declaration_json AS BLOB), CAST(body_declaration_token AS BLOB)
           FROM narrative_scene_scope_bindings
          WHERE project_id = ?1 AND scene_id = ?2",
        params![project_id, scene_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let (Ok(declaration_json), Ok(stored_token)) = (
        String::from_utf8(json_bytes),
        String::from_utf8(token_bytes),
    ) else {
        return Ok(Unavailable(Reason::Malformed));
    };
    let declaration = match NarrativeSceneBodyDeclarationV1::parse_json(&declaration_json) {
        Ok(declaration) => declaration,
        Err(NarrativeSceneBodyDeclarationParseError::Oversized) => {
            return Ok(Unavailable(Reason::Oversized))
        }
        Err(NarrativeSceneBodyDeclarationParseError::Malformed) => {
            return Ok(Unavailable(Reason::Malformed))
        }
        Err(NarrativeSceneBodyDeclarationParseError::UnsupportedVersion) => {
            return Ok(Unavailable(Reason::UnsupportedVersion))
        }
        Err(NarrativeSceneBodyDeclarationParseError::UnknownField) => {
            return Ok(Unavailable(Reason::UnknownField))
        }
    };
    if declaration.binding.project_id != project_id || declaration.binding.scene_id != scene_id {
        return Ok(Unavailable(Reason::SceneKeyMismatch));
    }
    if declaration.token()? != stored_token {
        return Ok(Unavailable(Reason::TokenMismatch));
    }
    Ok(Declared(StoredSceneBodyDeclaration {
        declaration,
        token: stored_token,
    }))
}

/// The facts of a Scene right now that a declaration's binding is compared
/// with. The caller computes them (the body digests and the canonical locator
/// are CB-4's reader); this module only compares.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SceneBodyDeclarationCurrentFacts {
    pub project_id: String,
    pub scene_id: String,
    pub scene_incarnation_id: String,
    /// The Scene's v1 Scene Scope `source_token` now.
    pub scope_source_token: String,
    pub body_source: NarrativeSceneBodySourceV1,
    pub title_digest: String,
    pub workspace_id: String,
    pub canonical_locator_digest: String,
}

/// A component of the binding that no longer holds.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SceneBodyDeclarationBindingMismatch {
    ProjectId,
    SceneId,
    SceneIncarnation,
    ScopeSourceToken,
    BodySourceIdentity,
    BodySourceToken,
    /// Storage digest, canonical digest, normalizer version or UTF-16 length.
    BodySourceDigest,
    TitleDigest,
    WorkspaceId,
    CanonicalLocatorDigest,
}

/// Compares a declaration's binding with the current facts. An empty result
/// means every component still holds; otherwise the declaration is expired and
/// never becomes valid again by itself (the caller does not rewrite it). Pure:
/// no I/O, no clock.
pub fn scene_body_declaration_binding_mismatches(
    declaration: &NarrativeSceneBodyDeclarationV1,
    current: &SceneBodyDeclarationCurrentFacts,
) -> Vec<SceneBodyDeclarationBindingMismatch> {
    use SceneBodyDeclarationBindingMismatch as Mismatch;
    let bound = &declaration.binding;
    let now = &current.body_source;
    let before = &bound.body_source;
    let checks = [
        (bound.project_id == current.project_id, Mismatch::ProjectId),
        (bound.scene_id == current.scene_id, Mismatch::SceneId),
        (
            bound.scene_incarnation_id == current.scene_incarnation_id,
            Mismatch::SceneIncarnation,
        ),
        (
            bound.scope_source_token == current.scope_source_token,
            Mismatch::ScopeSourceToken,
        ),
        (
            before.source_identity == now.source_identity,
            Mismatch::BodySourceIdentity,
        ),
        (
            before.source_token == now.source_token,
            Mismatch::BodySourceToken,
        ),
        (
            before.storage_digest == now.storage_digest
                && before.canonical_digest == now.canonical_digest
                && before.normalizer_version == now.normalizer_version
                && before.utf16_length == now.utf16_length,
            Mismatch::BodySourceDigest,
        ),
        (
            bound.title_digest == current.title_digest,
            Mismatch::TitleDigest,
        ),
        (
            bound.workspace_id == current.workspace_id,
            Mismatch::WorkspaceId,
        ),
        (
            bound.canonical_locator_digest == current.canonical_locator_digest,
            Mismatch::CanonicalLocatorDigest,
        ),
    ];
    checks
        .into_iter()
        .filter_map(|(holds, mismatch)| (!holds).then_some(mismatch))
        .collect()
}

pub fn scene_body_declaration_binding_holds(
    declaration: &NarrativeSceneBodyDeclarationV1,
    current: &SceneBodyDeclarationCurrentFacts,
) -> bool {
    scene_body_declaration_binding_mismatches(declaration, current).is_empty()
}

/// Which declarations a clear removes.
#[derive(Clone, Copy, Debug)]
pub(crate) enum SceneBodyDeclarationClearScope<'a> {
    Project,
    Scene(&'a str),
}

/// The one statement that writes the declaration columns to NULL. It touches
/// nothing else: `version`, `source_token`, `updated_at` and the A1 columns of
/// the row keep their bytes, so the v1 token and the Scope authority digest do
/// not move. Returns whether a row changed.
fn null_declaration_columns(conn: &Connection, project_id: &str, scene_id: &str) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE narrative_scene_scope_bindings
            SET body_declaration_json = NULL, body_declaration_token = NULL
          WHERE project_id = ?1 AND scene_id = ?2
            AND (body_declaration_json IS NOT NULL OR body_declaration_token IS NOT NULL)",
        params![project_id, scene_id],
    )?;
    Ok(changed > 0)
}

/// The clear of a staged restore image (backup restore and Safe Mode restore):
/// every project's declaration columns go to NULL in one transaction, before
/// the image becomes the workspace, so no restore can publish a declaration as
/// current. Writes nothing but the two columns (through the same single
/// `UPDATE`), no feed event (the staged image's restore Epoch is the boundary;
/// the declaration kind is outside history continuity, DR-CB1-7), and never
/// reads the cells, so a half-set or unknown-version row is cleared like any
/// other. Returns the number of rows cleared.
pub fn clear_all_scene_body_declarations_for_staged_restore(db: &crate::Database) -> Result<usize> {
    db.with_conn(|conn| {
        super::task_leases::with_immediate_transaction(conn, |conn| {
            let rows = {
                let mut statement = conn.prepare(
                    "SELECT project_id, scene_id
                       FROM narrative_scene_scope_bindings
                      WHERE body_declaration_json IS NOT NULL
                         OR body_declaration_token IS NOT NULL
                      ORDER BY project_id, scene_id",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            let mut cleared = 0;
            for (project_id, scene_id) in rows {
                if null_declaration_columns(conn, &project_id, &scene_id)? {
                    cleared += 1;
                }
            }
            Ok(cleared)
        })
    })
}

/// Sets both declaration columns of every declared (or half-declared or
/// corrupted) Scene in scope to NULL, in the caller's transaction, and returns
/// one feed event per Scene whose Scene exists in the project (ascending Scene
/// id). A row without such a Scene is cleared without an event: the feed
/// cannot address it. Never fails because of the stored content, so a restore
/// is not stopped by a broken row.
pub(crate) fn clear_scene_body_declarations_in_tx(
    conn: &Connection,
    project_id: &str,
    scope: SceneBodyDeclarationClearScope<'_>,
) -> Result<Vec<NarrativeChangeEventInput>> {
    let scene_filter = match scope {
        SceneBodyDeclarationClearScope::Project => None,
        SceneBodyDeclarationClearScope::Scene(scene_id) => Some(scene_id),
    };
    let mut statement = conn.prepare(
        "SELECT b.scene_id,
                EXISTS(SELECT 1 FROM tree_nodes s
                        WHERE s.id = b.scene_id AND s.project_id = b.project_id
                          AND s.node_type = 'scene')
           FROM narrative_scene_scope_bindings b
          WHERE b.project_id = ?1
            AND (b.body_declaration_json IS NOT NULL OR b.body_declaration_token IS NOT NULL)
            AND (?2 IS NULL OR b.scene_id = ?2)
          ORDER BY b.scene_id",
    )?;
    let targets = statement
        .query_map(params![project_id, scene_filter], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut events = Vec::new();
    for (scene_id, addressable) in targets {
        let before = canonical_scene_body_declaration_snapshot(conn, project_id, &scene_id)?;
        if !null_declaration_columns(conn, project_id, &scene_id)? {
            continue;
        }
        if addressable {
            let after = canonical_scene_body_declaration_snapshot(conn, project_id, &scene_id)?;
            events.push(scene_body_declaration_feed_event(
                &scene_id, &before, &after,
            )?);
        }
    }
    Ok(events)
}

/// A text cell read as raw bytes (`None` when it was above the limit and so
/// not read).
type RawCell = Option<Vec<u8>>;

/// The cell as the snapshot records it: its text, or, when it is not text, is
/// above the declaration limit or is not valid UTF-8, only its storage type
/// and length. Bytes that are not UTF-8 also carry their digest, so a change
/// of such a cell still changes the event digest. An over-limit cell is not
/// read.
fn snapshot_cell(storage_type: &str, octet_length: Option<i64>, bytes: RawCell) -> Value {
    match (storage_type, bytes) {
        ("null", _) => Value::Null,
        ("text", Some(bytes)) => match String::from_utf8(bytes) {
            Ok(text) => Value::String(text),
            Err(invalid) => json!({ "opaque": {
                "storageType": storage_type,
                "octetLength": octet_length,
                "invalidUtf8Digest": snapshot_bytes_digest(invalid.as_bytes()),
            } }),
        },
        _ => json!({ "opaque": { "storageType": storage_type, "octetLength": octet_length } }),
    }
}

fn snapshot_bytes_digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

/// The feed snapshot of a Scene's declaration: the two stored cells, or a
/// fixed value when both are NULL (or the Scene has no row). It is what the
/// event digests are computed from, so any change of a cell changes a digest.
/// It is deliberately not the v1 `scene-scope` snapshot.
pub(crate) fn canonical_scene_body_declaration_snapshot(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> Result<Value> {
    let none = json!({ "contractId": SNAPSHOT_CONTRACT_ID, "state": "none" });
    let row = conn
        .query_row(
            "SELECT typeof(body_declaration_json), octet_length(body_declaration_json),
                    CASE WHEN typeof(body_declaration_json) = 'text'
                          AND octet_length(body_declaration_json) <= ?3
                         THEN CAST(body_declaration_json AS BLOB) END,
                    typeof(body_declaration_token), octet_length(body_declaration_token),
                    CASE WHEN typeof(body_declaration_token) = 'text'
                          AND octet_length(body_declaration_token) <= ?4
                         THEN CAST(body_declaration_token AS BLOB) END
               FROM narrative_scene_scope_bindings
              WHERE project_id = ?1 AND scene_id = ?2",
            params![
                project_id,
                scene_id,
                i64::try_from(MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES)?,
                i64::try_from(MAX_NARRATIVE_SCENE_BODY_DECLARATION_TOKEN_BYTES)?,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, RawCell>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, RawCell>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((json_type, json_length, json_bytes, token_type, token_length, token_bytes)) = row
    else {
        return Ok(none);
    };
    if json_type == "null" && token_type == "null" {
        return Ok(none);
    }
    Ok(json!({
        "contractId": SNAPSHOT_CONTRACT_ID,
        "state": "stored",
        "json": snapshot_cell(&json_type, json_length, json_bytes),
        "token": snapshot_cell(&token_type, token_length, token_bytes),
    }))
}

/// The feed event for a declaration change: its own kind, `metadata`, and an
/// `update` that always carries both states (the snapshot has a fixed "none"
/// value). The structural impact has no `scopeAuthorityChanged`: the change is
/// not a change of the project's Scope authority.
pub(crate) fn scene_body_declaration_feed_event(
    scene_id: &str,
    before: &Value,
    after: &Value,
) -> Result<NarrativeChangeEventInput> {
    Ok(NarrativeChangeEventInput {
        object_key: json!({
            "kind": SCENE_BODY_DECLARATION_OBJECT_KIND,
            "sceneId": scene_id,
        }),
        change_kind: "metadata".to_owned(),
        mutation_kind: "update".to_owned(),
        before_version: None,
        before_digest: Some(narrative_snapshot_digest(before)?),
        after_version: None,
        after_digest: Some(narrative_snapshot_digest(after)?),
        changed_paths: vec![CHANGED_PATH.to_owned()],
        text_impact: None,
        structural_impact: Some(json!({ "changedPaths": [CHANGED_PATH] })),
    })
}

/// True when the transaction's events are all declaration events (and there is
/// at least one). Only then does the feed append leave the Chronicle and Graph
/// Indexes alone: a declaration is not an input of either Index (C17). Any
/// other kind in the transaction, or no event, keeps today's behavior.
pub(crate) fn events_are_only_scene_body_declarations(
    events: &[NarrativeChangeEventInput],
) -> bool {
    !events.is_empty()
        && events
            .iter()
            .all(|event| is_scene_body_declaration_event(&event.object_key))
}

/// True for the object key of a declaration event. The feed's history
/// continuity check does not chain this kind: its `before` comes from the
/// stored row, which also changes without an event.
pub(crate) fn is_scene_body_declaration_event(object_key: &Value) -> bool {
    object_key.get("kind").and_then(Value::as_str) == Some(SCENE_BODY_DECLARATION_OBJECT_KIND)
}

mod binding;
mod display;
mod limits;
mod veto;

pub use binding::{
    declaration_values_digest, BodyDeclarationBinding, ConsumedBodyDeclarationBinding,
    DeclareRefusal, DeclareRequest, DeclareResponse, ExpectedDeclarationOcc, RevokeRequest,
    RevokeResponse, StateComponent, MAX_DECLARATION_REQUEST_ID_BYTES,
};
pub use display::{
    build_body_declaration_display, sanitize_display_title, scene_body_title_digest,
    BodyDeclarationDisplay, DisplayTitle, DISPLAY_TITLE_MAX_SCALARS,
};
pub use limits::{
    SCENE_BODY_READ_MAX_BYTES, SCENE_BODY_READ_PEAK_MAX_BYTES, SCENE_BODY_TITLE_MAX_BYTES,
    SCENE_BODY_VETO_MAX_ROWS, VETO_CONTENT_LIMIT_MARKER, VETO_ROW_LIMIT_MARKER,
};
#[cfg(feature = "native-current-human-capture")]
pub(in crate::narrative_extraction) use veto::scene_body_declaration_veto_records;
pub use veto::{scene_body_declaration_veto, BodyDeclarationVeto, VetoLimits};

// The writers need the bounded Scene reader, which exists only in the Electron
// Native build (`native-current-human-capture`). grimodex-mcp never enables
// it, so no MCP tool and no generic path can reach a declaration writer.
#[cfg(feature = "native-current-human-capture")]
mod commit_outcome;
#[cfg(feature = "native-current-human-capture")]
mod facts;
#[cfg(feature = "native-current-human-capture")]
mod revoke;
#[cfg(feature = "native-current-human-capture")]
mod writer;

#[cfg(all(
    feature = "native-current-human-capture",
    any(test, feature = "workspace-maintenance-test-support")
))]
pub use commit_outcome::{
    clear_scene_body_declaration_quarantine_for_test,
    clear_scene_body_declaration_workspace_quarantine_for_test,
    quarantine_scene_body_declaration_workspace_for_test,
};
#[cfg(feature = "native-current-human-capture")]
pub use commit_outcome::{
    is_scene_body_declaration_quarantined, is_workspace_scene_body_declaration_quarantined,
    DeclarationTerminalEvidence, TerminalKind,
};
#[cfg(feature = "native-current-human-capture")]
pub(in crate::narrative_extraction) use facts::archived_in_chain;
#[cfg(feature = "native-current-human-capture")]
pub use facts::{preview_scene_body_declaration, BodyDeclarationPreview};
#[cfg(feature = "native-current-human-capture")]
pub use revoke::{revoke_scene_body, RevokeOutcome};
#[cfg(feature = "native-current-human-capture")]
pub use writer::{declare_scene_body, DeclareFailure, DeclareOutcome};

#[cfg(test)]
mod commit_outcome_tests;
#[cfg(test)]
mod display_tests;
#[cfg(test)]
pub(crate) mod invalidation_tests;
#[cfg(test)]
mod lifecycle_tests;
#[cfg(test)]
mod locator_tests;
#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod veto_tests;
#[cfg(test)]
pub(crate) mod writer_support_tests;
#[cfg(test)]
mod writer_tests;
