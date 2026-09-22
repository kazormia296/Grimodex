//! Source revision resolution for Prepared Commit source-basis OCC.
//!
//! Source references are deliberately logical.  This registry resolves the
//! small set of source kinds that Gate B2 can bind to a current revision token
//! without adding foreign keys from provenance history into source/domain
//! tables.  Unknown kinds and malformed keys fail closed.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::Digest;
use std::fmt;

use super::change_feed;
use super::project_scope_authority::load_live_project_scope_authority;

/// A borrowed validation capability for a whole-eligibility read.  The
/// connection and lifecycle owner are coupled in one value so callers cannot
/// accidentally resolve a long roster on a different connection or silently
/// re-admit a nested maintenance operation.  The owner is never retained by a
/// Source result.
pub(crate) struct ValidationConnectionScope<'conn> {
    connection: &'conn Connection,
}

pub(crate) struct ValidationContext<'conn, 'owner> {
    scope: ValidationConnectionScope<'conn>,
    owner: &'owner mut dyn super::nir1_entity_relation_index::GraphWorkControl,
}

/// Explicit foreground writer owner for compatibility entry points that run
/// inside the caller's transaction.  It is intentionally scoped to that
/// transaction and has no authority outside it; maintenance and Native
/// commands provide their cancelling owner instead.
pub(crate) struct ForegroundValidationControl;

impl super::nir1_entity_relation_index::GraphWorkControl for ForegroundValidationControl {
    fn check(
        &mut self,
        _stage: super::nir1_entity_relation_index::GraphWorkStage,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

impl<'conn, 'owner> ValidationContext<'conn, 'owner> {
    pub(crate) fn ensure_connection(&self, candidate: &Connection) -> anyhow::Result<()> {
        anyhow::ensure!(
            std::ptr::eq(self.scope.connection, candidate),
            "NEX_VALIDATION_CONTEXT_CONNECTION_MISMATCH: validation context must borrow the enclosing transaction"
        );
        Ok(())
    }

    pub(crate) fn control(
        &mut self,
    ) -> &mut dyn super::nir1_entity_relation_index::GraphWorkControl {
        self.owner
    }

    pub(crate) fn connection(&self) -> &'conn Connection {
        self.scope.connection
    }
}

pub(crate) fn validation_context<'conn, 'owner>(
    connection: &'conn Connection,
    owner: &'owner mut dyn super::nir1_entity_relation_index::GraphWorkControl,
) -> ValidationContext<'conn, 'owner> {
    ValidationContext {
        scope: ValidationConnectionScope { connection },
        owner,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CurrentSourceRevision {
    pub revision_token: String,
}

/// A validation attempt can be stopped for reasons that are different from a
/// Source being absent or stale.  The outer maintenance owner supplies this
/// marker when it stops an attempt; Source, Verify, Rebuild, and disclosure
/// readers must preserve it through their `anyhow` chains rather than turning
/// it into an ordinary domain result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum ValidationTerminationReason {
    ContextUnavailable,
    Cancelled,
    TimedOut,
    Closed,
    WorkspaceGenerationChanged,
    ForegroundPreempted,
    CleanupFailed,
    CapacityExceeded,
}

impl ValidationTerminationReason {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::ContextUnavailable => "context-unavailable",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timeout",
            Self::Closed => "closed",
            Self::WorkspaceGenerationChanged => "workspace-generation-changed",
            Self::ForegroundPreempted => "foreground-preempted",
            Self::CleanupFailed => "cleanup-failed",
            Self::CapacityExceeded => "capacity-exceeded",
        }
    }
}

/// Typed process-local signal for an interrupted validation.  It is not a
/// persisted authority or a replacement for the maintenance lifecycle
/// receipt; it exists solely to stop read/verify helpers from coercing an
/// interruption into `missing`, `stale`, `Unknown`, or a successful result.
#[derive(Debug)]
#[allow(dead_code)]
pub struct ValidationTerminated {
    pub reason: ValidationTerminationReason,
    message: String,
}

impl ValidationTerminated {
    #[allow(dead_code)]
    pub fn new(reason: ValidationTerminationReason, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

impl fmt::Display for ValidationTerminated {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "NEX_VALIDATION_TERMINATED:{}: {}",
            self.reason.code(),
            self.message
        )
    }
}

impl std::error::Error for ValidationTerminated {}

#[allow(dead_code)]
pub fn validation_terminated(
    reason: ValidationTerminationReason,
    message: impl Into<String>,
) -> anyhow::Error {
    anyhow::Error::new(ValidationTerminated::new(reason, message))
}

/// `anyhow` preserves this marker when callers add context.  Keep the check
/// in one place so every reader makes the same distinction from routine
/// Source absence/staleness.
pub(crate) fn is_validation_capacity_exceeded(error: &anyhow::Error) -> bool {
    error.downcast_ref::<ValidationTerminated>()
        .is_some_and(|error| error.reason == ValidationTerminationReason::CapacityExceeded)
}

pub fn is_validation_terminated(error: &anyhow::Error) -> bool {
    error.downcast_ref::<ValidationTerminated>().is_some()
}

pub(crate) fn resolve_source_revision(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    source_kind: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    match source_kind {
        "snapshot-document" => resolve_snapshot_document(conn, project_id, run_id, source_key),
        "scene-body" => resolve_scene_body(conn, project_id, source_key),
        "domain-projection" | "projection" => {
            resolve_domain_projection(conn, project_id, source_key)
        }
        "codex-catalog" => resolve_codex_catalog(conn, project_id, source_key),
        "codex-entry" | "codex-relation" => {
            let token = super::nir1_entity_relation::typed_source_token_for_incremental(
                conn, project_id, source_key,
            )?;
            token
                .map(|value| CurrentSourceRevision {
                    revision_token: value,
                })
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_SOURCE_MISSING: typed Entity/Relation Source '{source_key}' was not found"
                    )
                })
        }
        "scope-dependency-projection-v1" => ensure_non_empty_token(
            super::scope_dependency_projection::resolve(conn, project_id, run_id, source_key)?,
        ),
        "project-scope-authority" => {
            let authority = load_live_project_scope_authority(conn, project_id, source_key)?;
            ensure_non_empty_token(authority.source.revision_token)
        }
        super::nir1_chronicle_index::SOURCE_KIND => {
            let _ = (conn, project_id, run_id, source_key);
            Err(validation_terminated(
                ValidationTerminationReason::ContextUnavailable,
                "Chronicle eligibility requires a caller-owned ValidationContext",
            ))
        }
        super::nir1_entity_relation_index::SOURCE_KIND => {
            let _ = (conn, project_id, run_id, source_key);
            Err(validation_terminated(
                ValidationTerminationReason::ContextUnavailable,
                "Entity/Relation eligibility requires a caller-owned ValidationContext",
            ))
        }
        "narrative-artifact" => resolve_narrative_artifact(conn, project_id, source_key),
        "import-capture" => resolve_import_capture(conn, source_key),
        "evidence-anchor" | "evidence" => resolve_evidence_anchor(conn, project_id, source_key),
        other => anyhow::bail!(
            "NEX_SOURCE_KIND_UNSUPPORTED: no source revision resolver is registered for '{other}'"
        ),
    }
}

/// Controlled Source re-resolution used by whole-project maintenance. The
/// ordinary resolver remains the compatibility entry point for short reads;
/// this variant binds the Graph eligibility Source to the caller's finite
/// work owner so a cancellation cannot be normalized as missing or stale.
pub(crate) fn resolve_source_revision_with_control(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    source_kind: &str,
    source_key: &str,
    control: &mut dyn super::nir1_entity_relation_index::GraphWorkControl,
) -> anyhow::Result<CurrentSourceRevision> {
    control.check(super::nir1_entity_relation_index::GraphWorkStage::Source)?;
    if source_kind == super::nir1_entity_relation_index::SOURCE_KIND {
        if !control.allows_full_eligibility() {
            return Err(validation_terminated(
                ValidationTerminationReason::ContextUnavailable,
                "Entity/Relation eligibility requires a caller-owned validation context",
            ));
        }
        anyhow::ensure!(
            source_key == super::nir1_entity_relation_index::source_key(project_id),
            "NEX_SOURCE_KEY_INVALID: Entity/Relation eligibility Source must belong to the exact project"
        );
        let source = if conn.is_autocommit() {
            let tx = conn.unchecked_transaction()?;
            super::nir1_entity_relation_index::read_eligibility_source_with_control(
                &tx, project_id, control,
            )?
        } else {
            super::nir1_entity_relation_index::read_eligibility_source_with_control(
                conn, project_id, control,
            )?
        };
        return ensure_non_empty_token(source.digest);
    }
    if source_kind == super::nir1_chronicle_index::SOURCE_KIND {
        if !control.allows_full_eligibility() {
            return Err(validation_terminated(
                ValidationTerminationReason::ContextUnavailable,
                "Chronicle eligibility requires a caller-owned validation context",
            ));
        }
        anyhow::ensure!(
            source_key == super::nir1_chronicle_index::source::source_key(project_id),
            "NEX_SOURCE_KEY_INVALID: eligibility Source must belong to the exact project"
        );
        let source = if conn.is_autocommit() {
            let tx = conn.unchecked_transaction()?;
            super::nir1_chronicle_index::source::read_eligibility_source_with_control(
                &tx, project_id, control,
            )?
        } else {
            super::nir1_chronicle_index::source::read_eligibility_source_with_control(
                conn, project_id, control,
            )?
        };
        return ensure_non_empty_token(source.digest);
    }
    // Source kinds without a controlled Graph reader retain their existing
    // canonical implementation. Re-check after it returns so a SQLite
    // interruption or a stop arriving during that read cannot be normalized
    // by a caller into an ordinary missing/stale diagnostic.
    match resolve_source_revision(conn, project_id, run_id, source_kind, source_key) {
        Ok(current) => {
            control.check(super::nir1_entity_relation_index::GraphWorkStage::Source)?;
            Ok(current)
        }
        Err(error) if is_validation_terminated(&error) => Err(error),
        Err(error) => {
            control.check(super::nir1_entity_relation_index::GraphWorkStage::Source)?;
            Err(error)
        }
    }
}

/// Resolve a Source using the connection and lifecycle owner captured by
/// [`ValidationContext`].  This is the preferred entry point for Prepare,
/// Apply, Freshness and Chronicle maintenance callsites that may reach a
/// whole-project eligibility roster.
pub(crate) fn resolve_source_revision_with_validation_context(
    context: &mut ValidationContext<'_, '_>,
    project_id: &str,
    run_id: &str,
    source_kind: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let conn = context.scope.connection;
    resolve_source_revision_with_control(
        conn,
        project_id,
        run_id,
        source_kind,
        source_key,
        context.control(),
    )
}

/// Lazy-load-safe summary of a source's current state. Deliberately has no
/// `canonical_text` (or any other body-shaped) field: this is the contract
/// that lets callers cheaply check "did the source I bound to change" on
/// every Prepared Commit / Edge revalidation without ever paying for a body
/// read. Only when a caller's held token/digest disagrees with this state
/// should it escalate to [`load_canonical_text_for_revalidation`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CurrentSourceState {
    pub exists: bool,
    pub usable: bool,
    pub revision_token: Option<String>,
    pub content_digest: Option<String>,
    pub version: Option<i64>,
    pub normalizer_version: Option<String>,
}

/// Resolves the current state of a source the way [`resolve_source_revision`]
/// does, except a missing source becomes `exists: false` and a durable but
/// non-current source becomes `usable: false` instead of either outcome being
/// an `Err`. This is the Lazy Text entry point: routine freshness checks (does
/// my bound source still exist as an addressable current Source, and if so
/// under what token) should call this instead of `resolve_source_revision`
/// directly, so deterministic domain unavailability does not have to be
/// special-cased by every caller as an infrastructure error.
///
/// This function never reads scene/document body content -- `version` and
/// `content_digest` are derived by parsing the already-resolved
/// `revision_token` string, not by issuing additional body-bearing queries.
/// Its cost is therefore independent of how large the underlying source is.
///
/// Gate C2 Lane E ships this as the Lazy Text entry point ahead of its Edge
/// revalidation callers; `#[allow(dead_code)]` is temporary until those
/// callers land.
#[allow(dead_code)]
pub(crate) fn resolve_current_source_state(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    source_kind: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceState> {
    current_source_state_from_resolution(
        source_kind,
        resolve_source_revision(conn, project_id, run_id, source_kind, source_key),
    )
}

/// Controlled counterpart for Verify/Restore paths. It deliberately shares
/// the same missing/stale normalization as the ordinary reader while keeping
/// `ValidationTerminated` errors intact.
pub(crate) fn resolve_current_source_state_with_control(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    source_kind: &str,
    source_key: &str,
    control: &mut dyn super::nir1_entity_relation_index::GraphWorkControl,
) -> anyhow::Result<CurrentSourceState> {
    control.check(super::nir1_entity_relation_index::GraphWorkStage::Source)?;
    current_source_state_from_resolution(
        source_kind,
        resolve_source_revision_with_control(
            conn,
            project_id,
            run_id,
            source_kind,
            source_key,
            control,
        ),
    )
}

/// Only the bounded, read-only edge batch owns this temporary authority.
/// Each versioned Scope Source still verifies its sealed Run/document binding.
/// Do not retain this state between batches or across a write in the caller.
pub(super) fn resolve_current_source_state_in_batch_with_control(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    source_kind: &str,
    source_key: &str,
    authority: &mut Option<
        grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
    >,
    control: &mut dyn super::nir1_entity_relation_index::GraphWorkControl,
) -> anyhow::Result<CurrentSourceState> {
    anyhow::ensure!(!conn.is_autocommit(), "Source batch requires a transaction");
    control.check(super::nir1_entity_relation_index::GraphWorkStage::Source)?;
    let resolved = if source_kind == "scope-dependency-projection-v1" {
        (|| {
            if authority.is_none() {
                *authority = Some(load_live_project_scope_authority(
                    conn,
                    project_id,
                    &format!("project:scope-authority:{project_id}"),
                )?);
            }
            let authority = authority
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Scope batch authority unavailable"))?;
            ensure_non_empty_token(
                super::scope_dependency_projection::resolve_with_authority_in_tx(
                    conn, project_id, run_id, source_key, authority,
                )?,
            )
        })()
    } else {
        resolve_source_revision_with_control(
            conn,
            project_id,
            run_id,
            source_kind,
            source_key,
            control,
        )
    };
    current_source_state_from_resolution(source_kind, resolved)
}

fn current_source_state_from_resolution(
    source_kind: &str,
    resolved: anyhow::Result<CurrentSourceRevision>,
) -> anyhow::Result<CurrentSourceState> {
    let resolved = match resolved {
        Ok(resolved) => resolved,
        Err(error) if is_validation_terminated(&error) => return Err(error),
        Err(error) if is_source_missing_error(&error) => {
            return Ok(CurrentSourceState {
                exists: false,
                usable: false,
                revision_token: None,
                content_digest: None,
                version: None,
                normalizer_version: None,
            });
        }
        Err(error) if is_source_stale_error(&error) => {
            return Ok(CurrentSourceState {
                exists: true,
                usable: false,
                revision_token: None,
                content_digest: None,
                version: None,
                normalizer_version: None,
            });
        }
        Err(error) => return Err(error),
    };
    let CurrentSourceRevision { revision_token } = resolved;
    let version = parse_leading_version(&revision_token);
    let content_digest = revision_token
        .starts_with("sha256:")
        .then(|| revision_token.clone());
    let normalizer_version = (source_kind == "scene-body")
        .then(|| change_feed::CANONICAL_TEXT_NORMALIZER_VERSION.to_string());
    Ok(CurrentSourceState {
        exists: true,
        usable: true,
        revision_token: Some(revision_token),
        content_digest,
        version,
        normalizer_version,
    })
}

/// Loads the actual canonical body text for a source so a caller can
/// re-anchor a stale Range/quote against it.
///
/// # Contract
/// Call this ONLY after [`resolve_current_source_state`] (or an equivalent
/// token/digest comparison) has shown that the caller's held revision is
/// stale and a structural re-anchor is genuinely required. Do not call this
/// speculatively on every read or freshness check, and never forward its
/// return value verbatim into an IPC/N-API response payload -- full body
/// text must not leave this process boundary as part of routine
/// revalidation plumbing; it exists only to feed a server-side reanchor
/// computation.
///
/// Only `"scene-body"` is implemented today. Every other `source_kind` fails
/// closed with `NEX_CANONICAL_TEXT_UNSUPPORTED` rather than guessing at a
/// text representation; widening coverage to additional kinds is future
/// scope.
///
/// Gate C2 Lane E ships this ahead of its Edge revalidation callers;
/// `#[allow(dead_code)]` is temporary until those callers land.
#[allow(dead_code)]
pub(crate) fn load_canonical_text_for_revalidation(
    conn: &Connection,
    project_id: &str,
    source_kind: &str,
    source_key: &str,
) -> anyhow::Result<String> {
    match source_kind {
        "scene-body" => load_scene_canonical_text(conn, project_id, source_key),
        other => anyhow::bail!(
            "NEX_CANONICAL_TEXT_UNSUPPORTED: no canonical text loader is registered for '{other}'"
        ),
    }
}

fn load_scene_canonical_text(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<String> {
    let scene_id = source_key
        .strip_prefix("project:scene:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SOURCE_KEY_INVALID: scene-body sourceKey must be project:scene:<id>"
            )
        })?;
    let content: Option<String> = conn
        .query_row(
            "SELECT content
               FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![scene_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(content) = content else {
        anyhow::bail!("NEX_SOURCE_MISSING: scene '{scene_id}' was not found");
    };
    Ok(change_feed::scene_canonical_text(&content))
}

fn is_source_missing_error(error: &anyhow::Error) -> bool {
    error.to_string().contains("NEX_SOURCE_MISSING")
}

fn is_source_stale_error(error: &anyhow::Error) -> bool {
    error.to_string().contains("NEX_SOURCE_STALE")
}

/// Parses the `v<version>@...` token shape shared by scene-body,
/// domain-projection, and import-capture revision tokens. Returns `None` for
/// tokens that do not follow this shape -- snapshot-document, codex-catalog,
/// narrative-artifact, and evidence-anchor all encode digests instead, and
/// are left for a future kind-specific extension rather than guessed at.
fn parse_leading_version(token: &str) -> Option<i64> {
    let rest = token.strip_prefix('v')?;
    let (digits, _) = rest.split_once('@')?;
    digits.parse::<i64>().ok()
}

fn resolve_snapshot_document(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let snapshot_run_id = source_key
        .strip_prefix("snapshot:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SOURCE_KEY_INVALID: snapshot-document sourceKey must be snapshot:<runId>"
            )
        })?;
    anyhow::ensure!(
        snapshot_run_id == run_id,
        "NEX_SOURCE_PROJECT_MISMATCH: snapshot source does not belong to prepared run"
    );
    let row: Option<(String, Option<String>)> = conn
        .prepare_cached(
            "SELECT project_id, snapshot_digest
               FROM narrative_extraction_runs
              WHERE id = ?1",
        )?
        .query_row(params![snapshot_run_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    let Some((source_project_id, snapshot_digest)) = row else {
        anyhow::bail!("NEX_SOURCE_MISSING: snapshot run '{snapshot_run_id}' was not found");
    };
    anyhow::ensure!(
        source_project_id == project_id,
        "NEX_SOURCE_PROJECT_MISMATCH: snapshot run does not belong to project"
    );
    let revision_token = snapshot_digest.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_SOURCE_MISSING: snapshot run '{snapshot_run_id}' has no sealed snapshot digest"
        )
    })?;
    ensure_non_empty_token(revision_token)
}

fn resolve_scene_body(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let scene_id = source_key
        .strip_prefix("project:scene:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SOURCE_KEY_INVALID: scene-body sourceKey must be project:scene:<id>"
            )
        })?;
    let row: Option<(i64, String)> = conn
        .prepare_cached(
            "SELECT version, updated_at
               FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
        )?
        .query_row(params![scene_id, project_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    let Some((version, updated_at)) = row else {
        anyhow::bail!("NEX_SOURCE_MISSING: scene '{scene_id}' was not found");
    };
    ensure_non_empty_token(format!("v{version}@{updated_at}"))
}

fn resolve_domain_projection(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let projection_id = source_key
        .strip_prefix("projection:")
        .filter(|value| !value.is_empty())
        .unwrap_or(source_key);
    let row: Option<(i64, String, String)> = conn
        .query_row(
            "SELECT version, updated_at, status
               FROM narrative_temporal_projections
              WHERE id = ?1 AND project_id = ?2",
            params![projection_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((version, updated_at, status)) = row else {
        anyhow::bail!("NEX_SOURCE_MISSING: projection '{projection_id}' was not found");
    };
    anyhow::ensure!(
        status == "current",
        "NEX_SOURCE_STALE: projection '{projection_id}' is not current"
    );
    ensure_non_empty_token(format!("v{version}@{updated_at}"))
}

fn resolve_codex_catalog(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    conn.execute_batch("SAVEPOINT narrative_codex_catalog_snapshot")?;
    let result = resolve_codex_catalog_in_snapshot(conn, project_id, source_key);
    match result {
        Ok(resolved) => {
            conn.execute_batch("RELEASE SAVEPOINT narrative_codex_catalog_snapshot")?;
            Ok(resolved)
        }
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT narrative_codex_catalog_snapshot;
                 RELEASE SAVEPOINT narrative_codex_catalog_snapshot;",
            );
            Err(error)
        }
    }
}

fn resolve_codex_catalog_in_snapshot(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let catalog_project_id = source_key
        .strip_prefix("project:codex-catalog:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SOURCE_KEY_INVALID: codex-catalog sourceKey must be project:codex-catalog:<id>"
            )
        })?;
    anyhow::ensure!(
        catalog_project_id == project_id,
        "NEX_SOURCE_PROJECT_MISMATCH: codex catalog does not belong to project"
    );

    let entries = conn
        .prepare(
            "SELECT id, parent_id, type, name, aliases, excluded_aliases, readings,
                    summary, content, icon, context_mode, children_budget, notes, version
               FROM codex_entries
              WHERE project_id = ?1
              ORDER BY id ASC",
        )?
        .query_map(params![project_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "parentId": row.get::<_, Option<String>>(1)?,
                "type": row.get::<_, String>(2)?,
                "name": row.get::<_, String>(3)?,
                "aliases": row.get::<_, Option<String>>(4)?,
                "excludedAliases": row.get::<_, Option<String>>(5)?,
                "readings": row.get::<_, Option<String>>(6)?,
                "summary": row.get::<_, Option<String>>(7)?,
                "content": row.get::<_, String>(8)?,
                "icon": row.get::<_, Option<String>>(9)?,
                "contextMode": row.get::<_, String>(10)?,
                "childrenBudget": row.get::<_, String>(11)?,
                "notes": row.get::<_, Option<String>>(12)?,
                "version": row.get::<_, i64>(13)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let relations = conn
        .prepare(
            "SELECT id, from_codex_id, to_codex_id, relation_type, label,
                    directionality, inverse_label, semantic_key, depth_hint,
                    source_map_edge_id, version
               FROM codex_relations
              WHERE project_id = ?1
              ORDER BY id ASC",
        )?
        .query_map(params![project_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "fromCodexId": row.get::<_, String>(1)?,
                "toCodexId": row.get::<_, String>(2)?,
                "relationType": row.get::<_, String>(3)?,
                "label": row.get::<_, Option<String>>(4)?,
                "directionality": row.get::<_, String>(5)?,
                "inverseLabel": row.get::<_, Option<String>>(6)?,
                "semanticKey": row.get::<_, String>(7)?,
                "depthHint": row.get::<_, Option<i64>>(8)?,
                "sourceMapEdgeId": row.get::<_, Option<String>>(9)?,
                "version": row.get::<_, i64>(10)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let phases = conn
        .prepare(
            "SELECT phase.id, phase.entry_id, phase.anchor_node_id, phase.label,
                    phase.summary_override, phase.content_override,
                    phase.context_mode_override, phase.version
               FROM codex_entry_phases phase
               INNER JOIN codex_entries entry ON entry.id = phase.entry_id
              WHERE entry.project_id = ?1
              ORDER BY phase.id ASC",
        )?
        .query_map(params![project_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "entryId": row.get::<_, String>(1)?,
                "anchorNodeId": row.get::<_, Option<String>>(2)?,
                "label": row.get::<_, String>(3)?,
                "summaryOverride": row.get::<_, Option<String>>(4)?,
                "contentOverride": row.get::<_, Option<String>>(5)?,
                "contextModeOverride": row.get::<_, Option<String>>(6)?,
                "version": row.get::<_, i64>(7)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let detail_definitions = conn
        .prepare(
            "SELECT id, type_slug, name, field_type, field_config, sort_order,
                    include_in_context, version
               FROM codex_detail_definitions
              WHERE project_id = ?1
              ORDER BY id ASC",
        )?
        .query_map(params![project_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "typeSlug": row.get::<_, String>(1)?,
                "name": row.get::<_, String>(2)?,
                "fieldType": row.get::<_, String>(3)?,
                "fieldConfig": row.get::<_, Option<String>>(4)?,
                "sortOrder": row.get::<_, f64>(5)?,
                "includeInContext": row.get::<_, i64>(6)?,
                "version": row.get::<_, i64>(7)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let detail_values = conn
        .prepare(
            "SELECT value.id, value.entry_id, value.definition_id, value.value,
                    value.version
               FROM codex_detail_values value
               INNER JOIN codex_entries entry ON entry.id = value.entry_id
              WHERE entry.project_id = ?1
              ORDER BY value.id ASC",
        )?
        .query_map(params![project_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "entryId": row.get::<_, String>(1)?,
                "definitionId": row.get::<_, String>(2)?,
                "value": row.get::<_, Option<String>>(3)?,
                "version": row.get::<_, i64>(4)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let types = conn
        .prepare(
            "SELECT id, slug, label, color, palette_index, icon, is_builtin, sort_order
               FROM codex_types
              WHERE project_id = ?1
              ORDER BY id ASC",
        )?
        .query_map(params![project_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "slug": row.get::<_, String>(1)?,
                "label": row.get::<_, String>(2)?,
                "color": row.get::<_, String>(3)?,
                "paletteIndex": row.get::<_, Option<i64>>(4)?,
                "icon": row.get::<_, Option<String>>(5)?,
                "isBuiltin": row.get::<_, i64>(6)?,
                "sortOrder": row.get::<_, f64>(7)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let tags = conn
        .prepare(
            "SELECT id, name, color, type_filter
               FROM codex_tags
              WHERE project_id = ?1
              ORDER BY id ASC",
        )?
        .query_map(params![project_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "color": row.get::<_, Option<String>>(2)?,
                "typeFilter": row.get::<_, Option<String>>(3)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let entry_tags = conn
        .prepare(
            "SELECT association.entry_id, association.tag_id
               FROM codex_entry_tags association
               INNER JOIN codex_entries entry ON entry.id = association.entry_id
               INNER JOIN codex_tags tag ON tag.id = association.tag_id
              WHERE entry.project_id = ?1 AND tag.project_id = ?1
              ORDER BY association.entry_id ASC, association.tag_id ASC",
        )?
        .query_map(params![project_id], |row| {
            Ok(json!({
                "entryId": row.get::<_, String>(0)?,
                "tagId": row.get::<_, String>(1)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let semantic_bindings = conn
        .prepare(
            "SELECT id, definition_id, facet_key, projection_kind, temporal_policy,
                    source, confirmed, version
               FROM codex_detail_semantic_bindings
              WHERE project_id = ?1
              ORDER BY id ASC",
        )?
        .query_map(params![project_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "definitionId": row.get::<_, String>(1)?,
                "facetKey": row.get::<_, String>(2)?,
                "projectionKind": row.get::<_, String>(3)?,
                "temporalPolicy": row.get::<_, String>(4)?,
                "source": row.get::<_, String>(5)?,
                "confirmed": row.get::<_, i64>(6)?,
                "version": row.get::<_, i64>(7)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let phase_detail_overrides = conn
        .prepare(
            "SELECT detail_override.phase_id, detail_override.definition_id, detail_override.value
               FROM codex_phase_detail_overrides detail_override
               INNER JOIN codex_entry_phases phase ON phase.id = detail_override.phase_id
               INNER JOIN codex_entries entry ON entry.id = phase.entry_id
              WHERE entry.project_id = ?1
              ORDER BY detail_override.phase_id ASC, detail_override.definition_id ASC",
        )?
        .query_map(params![project_id], |row| {
            Ok(json!({
                "phaseId": row.get::<_, String>(0)?,
                "definitionId": row.get::<_, String>(1)?,
                "value": row.get::<_, Option<String>>(2)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    ensure_non_empty_token(format!(
        "sha256:{}",
        digest_json(&json!({
            "entries": entries,
            "relations": relations,
            "phases": phases,
            "detailDefinitions": detail_definitions,
            "detailValues": detail_values,
            "types": types,
            "tags": tags,
            "entryTags": entry_tags,
            "semanticBindings": semantic_bindings,
            "phaseDetailOverrides": phase_detail_overrides,
        }))?
    ))
}

fn resolve_narrative_artifact(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let artifact_id = source_key
        .strip_prefix("artifact:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SOURCE_KEY_INVALID: narrative-artifact sourceKey must be artifact:<id>"
            )
        })?;
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT a.payload_digest, a.payload_json
               FROM narrative_extraction_artifacts a
               INNER JOIN narrative_extraction_runs r ON r.id = a.run_id
              WHERE a.id = ?1 AND r.project_id = ?2",
            params![artifact_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((payload_digest, payload_json)) = row else {
        anyhow::bail!("NEX_SOURCE_MISSING: artifact '{artifact_id}' was not found");
    };
    if let Some(payload_digest) = payload_digest {
        return ensure_non_empty_token(payload_digest);
    }
    let payload_json = payload_json.ok_or_else(|| {
        anyhow::anyhow!("NEX_SOURCE_MISSING: artifact '{artifact_id}' has no payload")
    })?;
    let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
        anyhow::anyhow!("NEX_SOURCE_INVALID: artifact payload is invalid: {error}")
    })?;
    ensure_non_empty_token(format!("sha256:{}", digest_json(&payload)?))
}

fn resolve_import_capture(
    conn: &Connection,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let capture_id = source_key
        .strip_prefix("capture:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_SOURCE_KEY_INVALID: import-capture sourceKey must be capture:<id>")
        })?;
    let row: Option<(String, Option<String>, i64)> = conn
        .query_row(
            "SELECT state, sealed_digest, version
               FROM import_captures
              WHERE id = ?1",
            params![capture_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((state, sealed_digest, version)) = row else {
        anyhow::bail!("NEX_SOURCE_MISSING: import capture '{capture_id}' was not found");
    };
    anyhow::ensure!(
        state == "sealed",
        "NEX_SOURCE_STALE: import capture '{capture_id}' is not sealed"
    );
    let sealed_digest = sealed_digest.ok_or_else(|| {
        anyhow::anyhow!("NEX_SOURCE_MISSING: import capture '{capture_id}' has no sealed digest")
    })?;
    ensure_non_empty_token(format!("v{version}@{sealed_digest}"))
}

fn resolve_evidence_anchor(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<CurrentSourceRevision> {
    let anchor_id = source_key
        .strip_prefix("evidence:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SOURCE_KEY_INVALID: evidence-anchor sourceKey must be evidence:<id>"
            )
        })?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT b.source_document_digest, b.committed_storage_digest
               FROM import_evidence_bindings b
               INNER JOIN tree_nodes n
                       ON n.id = b.target_scene_id
                      AND n.project_id = ?1
              WHERE b.evidence_anchor_id = ?2
              ORDER BY b.committed_at DESC, b.rowid DESC
              LIMIT 1",
            params![project_id, anchor_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((source_document_digest, committed_storage_digest)) = row else {
        anyhow::bail!("NEX_SOURCE_MISSING: evidence anchor '{anchor_id}' was not found");
    };
    ensure_non_empty_token(format!(
        "{source_document_digest}@{committed_storage_digest}"
    ))
}

fn ensure_non_empty_token<T>(token: T) -> anyhow::Result<CurrentSourceRevision>
where
    T: Into<String>,
{
    let revision_token = token.into();
    anyhow::ensure!(
        !revision_token.is_empty(),
        "NEX_SOURCE_MISSING: resolved source revision token is empty"
    );
    Ok(CurrentSourceRevision { revision_token })
}

fn digest_json(value: &Value) -> anyhow::Result<String> {
    let canonical = canonical_json_string(value)?;
    Ok(hex::encode(sha2::Sha256::digest(canonical.as_bytes())))
}

fn canonical_json_string(value: &Value) -> anyhow::Result<String> {
    serde_json::to_string(&canonical_json_value(value))
        .map_err(|error| anyhow::anyhow!("canonical source digest failed: {error}"))
}

fn canonical_json_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical_json_value).collect()),
        Value::Object(map) => {
            let mut entries: Vec<_> = map
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json_value(value)))
                .collect();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            Value::Object(entries.into_iter().collect())
        }
        _ => value.clone(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::Database;

    /// A single-paragraph ProseMirror doc whose canonical text is exactly
    /// `text` -- lets tests assert on `load_canonical_text_for_revalidation`
    /// output without depending on `collect_canonical_blocks` internals.
    fn scene_doc_json(text: &str) -> String {
        json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": text }]
            }]
        })
        .to_string()
    }

    fn test_db() -> Database {
        let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
        db.execute(
            "INSERT INTO projects (id, title) VALUES (?, 'Project')",
            &[Value::String("p1".into())],
            "run",
        )
        .expect("insert project");
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
             VALUES (?, ?, 'scene', 'Scene', ?)",
            &[
                Value::String("s1".into()),
                Value::String("p1".into()),
                Value::String(scene_doc_json("Hello world")),
            ],
            "run",
        )
        .expect("insert scene");
        db
    }

    #[test]
    fn current_source_state_is_exhaustively_destructurable_with_no_canonical_text_field() {
        // If a `canonical_text` (or any other body-shaped) field is ever
        // added to `CurrentSourceState`, this exhaustive destructure stops
        // compiling until the test is deliberately updated to name it --
        // making a silent "the lazy state now carries the body" regression
        // impossible to land unnoticed. This is the type-level guarantee
        // the design calls for, rather than a timing-based proxy.
        let state = CurrentSourceState {
            exists: true,
            usable: true,
            revision_token: Some("v0@2026-08-15T00:00:00.000Z".to_string()),
            content_digest: None,
            version: Some(0),
            normalizer_version: Some("gdx-canonical-text/1".to_string()),
        };
        let CurrentSourceState {
            exists,
            usable,
            revision_token,
            content_digest,
            version,
            normalizer_version,
        } = state;
        assert!(exists);
        assert!(usable);
        assert!(revision_token.is_some());
        assert!(content_digest.is_none());
        assert_eq!(version, Some(0));
        assert_eq!(normalizer_version.as_deref(), Some("gdx-canonical-text/1"));
    }

    #[test]
    fn resolve_current_source_state_reports_missing_source_without_erroring() {
        let db = test_db();
        db.with_conn(|conn| {
            let state = resolve_current_source_state(
                conn,
                "p1",
                "run-1",
                "scene-body",
                "project:scene:does-not-exist",
            )?;
            assert_eq!(
                state,
                CurrentSourceState {
                    exists: false,
                    usable: false,
                    revision_token: None,
                    content_digest: None,
                    version: None,
                    normalizer_version: None,
                }
            );
            Ok(())
        })
        .expect("resolve missing source state");
    }

    #[test]
    fn resolve_current_source_state_still_errors_on_malformed_source_key() {
        let db = test_db();
        db.with_conn(|conn| {
            let error =
                resolve_current_source_state(conn, "p1", "run-1", "scene-body", "not-a-valid-key")
                    .expect_err("malformed sourceKey must still fail closed");
            assert!(error.to_string().contains("NEX_SOURCE_KEY_INVALID"));
            Ok(())
        })
        .expect("run malformed key check");
    }

    #[test]
    fn validation_termination_survives_source_state_normalization() {
        let error = validation_terminated(
            ValidationTerminationReason::ForegroundPreempted,
            "foreground work arrived while validating",
        );
        let normalized = current_source_state_from_resolution(
            "scene-body",
            Err::<CurrentSourceRevision, _>(error.context("source resolver context")),
        )
        .expect_err("an interruption must not become missing or stale");
        assert!(is_validation_terminated(&normalized));
        let marker = normalized
            .downcast_ref::<ValidationTerminated>()
            .expect("typed termination marker");
        assert_eq!(
            marker.reason,
            ValidationTerminationReason::ForegroundPreempted
        );
    }

    #[test]
    fn resolve_current_source_state_for_large_scene_body_never_grows_with_body_length() {
        // A ~64,000 char body. If `resolve_current_source_state` ever started
        // loading the body (e.g. to hash it for `content_digest`), the
        // resulting token/digest strings would scale with this length. They
        // must not: the struct has no field capable of holding the body, and
        // every field it does return stays short regardless of body size.
        let big_text = "A".repeat(64_000);
        let db = test_db();
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
             VALUES ('s-big', 'p1', 'scene', 'Big Scene', ?)",
            &[Value::String(scene_doc_json(&big_text))],
            "run",
        )
        .expect("insert big scene");

        db.with_conn(|conn| {
            let state = resolve_current_source_state(
                conn,
                "p1",
                "run-1",
                "scene-body",
                "project:scene:s-big",
            )?;
            let CurrentSourceState {
                exists,
                usable,
                revision_token,
                content_digest,
                version,
                normalizer_version,
            } = state;
            assert!(exists);
            assert!(usable);
            let token = revision_token.expect("token present for existing source");
            assert!(
                token.len() < 128,
                "revision token must stay short regardless of body length, got {} bytes",
                token.len()
            );
            assert_eq!(version, Some(0));
            assert!(content_digest.is_none());
            assert_eq!(normalizer_version.as_deref(), Some("gdx-canonical-text/1"));
            Ok(())
        })
        .expect("resolve large scene source state");
    }

    #[test]
    fn load_canonical_text_for_revalidation_returns_the_actual_scene_body() {
        let db = test_db();
        db.with_conn(|conn| {
            let text =
                load_canonical_text_for_revalidation(conn, "p1", "scene-body", "project:scene:s1")?;
            assert_eq!(text, "Hello world");
            Ok(())
        })
        .expect("load scene canonical text");
    }

    #[test]
    fn load_canonical_text_for_revalidation_returns_full_length_body_when_explicitly_called() {
        let big_text = "B".repeat(64_000);
        let db = test_db();
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
             VALUES ('s-big', 'p1', 'scene', 'Big Scene', ?)",
            &[Value::String(scene_doc_json(&big_text))],
            "run",
        )
        .expect("insert big scene");

        db.with_conn(|conn| {
            let text = load_canonical_text_for_revalidation(
                conn,
                "p1",
                "scene-body",
                "project:scene:s-big",
            )?;
            assert_eq!(text, big_text);
            Ok(())
        })
        .expect("load big scene canonical text");
    }

    #[test]
    fn load_canonical_text_for_revalidation_fails_closed_for_unsupported_source_kind() {
        let db = test_db();
        db.with_conn(|conn| {
            let error = load_canonical_text_for_revalidation(
                conn,
                "p1",
                "domain-projection",
                "projection:whatever",
            )
            .expect_err("unsupported kind must fail closed");
            assert!(error.to_string().contains("NEX_CANONICAL_TEXT_UNSUPPORTED"));
            Ok(())
        })
        .expect("run unsupported kind check");
    }

    #[test]
    fn load_canonical_text_for_revalidation_reports_missing_scene() {
        let db = test_db();
        db.with_conn(|conn| {
            let error = load_canonical_text_for_revalidation(
                conn,
                "p1",
                "scene-body",
                "project:scene:does-not-exist",
            )
            .expect_err("missing scene must fail closed");
            assert!(error.to_string().contains("NEX_SOURCE_MISSING"));
            Ok(())
        })
        .expect("run missing scene check");
    }

    #[test]
    fn codex_catalog_digest_tracks_unversioned_and_same_version_semantic_content() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO codex_types (id, project_id, slug, label)
                 VALUES ('type-custom', 'p1', 'custom', 'Before')",
                [],
            )?;
            let source_key = "project:codex-catalog:p1";
            let before_type = resolve_codex_catalog(conn, "p1", source_key)?.revision_token;
            conn.execute(
                "UPDATE codex_types SET label = 'After' WHERE id = 'type-custom'",
                [],
            )?;
            let after_type = resolve_codex_catalog(conn, "p1", source_key)?.revision_token;
            assert_ne!(before_type, after_type, "type rows have no OCC version");

            let before_tag = after_type;
            conn.execute(
                "INSERT INTO codex_tags (id, project_id, name)
                 VALUES ('tag-1', 'p1', 'Hero')",
                [],
            )?;
            let after_tag = resolve_codex_catalog(conn, "p1", source_key)?.revision_token;
            assert_ne!(before_tag, after_tag, "tags must contribute to the catalog");

            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, content, version)
                 VALUES ('entry-reused', 'p1', 'character', 'Before', '{}', 7)",
                [],
            )?;
            let before_recreate = resolve_codex_catalog(conn, "p1", source_key)?.revision_token;
            conn.execute("DELETE FROM codex_entries WHERE id = 'entry-reused'", [])?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, content, version)
                 VALUES ('entry-reused', 'p1', 'character', 'After', '{}', 7)",
                [],
            )?;
            let after_recreate = resolve_codex_catalog(conn, "p1", source_key)?.revision_token;
            assert_ne!(
                before_recreate, after_recreate,
                "same id/version with different semantic content must not collide"
            );
            Ok(())
        })
        .expect("compare Codex aggregate revisions");
    }

    #[test]
    fn eligibility_resolution_without_context_is_typed_before_sql() {
        let conn = Connection::open_in_memory().expect("connection");
        let error = resolve_source_revision(
            &conn,
            "project",
            "run",
            super::super::nir1_chronicle_index::SOURCE_KIND,
            "chronicle-eligibility:project",
        )
        .expect_err("whole eligibility must require caller-owned context");
        assert!(is_validation_terminated(&error));
        assert!(error.to_string().contains("context-unavailable"));
    }
}
