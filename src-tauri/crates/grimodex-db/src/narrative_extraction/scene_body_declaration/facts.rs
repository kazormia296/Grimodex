//! The current facts of a Scene for a body declaration, and the preview.
//!
//! One function, [`read_scene_facts_in_tx`], reads every fact a declaration is
//! bound to. The preview calls it in a bounded read transaction; the writer
//! calls it again inside its write transaction and compares the result with
//! the consumed binding, so the preview and the write cannot see different
//! rules. The body's digests are always computed from the bytes read in that
//! transaction.

use std::fmt;

use anyhow::{ensure, Result};
use grimodex_core::narrative_scene_body_declaration::{
    NarrativeSceneBodyDeclarationValuesV1, NarrativeSceneBodySourceV1,
    MAX_NARRATIVE_SCENE_BODY_DECLARATION_TOKEN_BYTES,
};
use grimodex_core::narrative_scene_scope::{
    is_unresolved, NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
    NarrativeScopeCompatibilityMarkerV1,
};
use rusqlite::{params, Connection, OptionalExtension};

use super::binding::{
    declaration_values_digest, BodyDeclarationBinding, DeclareRefusal, DeclareRequest,
    StateComponent,
};
use super::commit_outcome::is_scene_body_declaration_quarantined;
use super::display::{
    build_body_declaration_display, scene_body_title_digest, BodyDeclarationDisplay,
};
use super::limits::{
    SCENE_BODY_READ_MAX_BYTES, SCENE_BODY_READ_PEAK_MAX_BYTES, SCENE_BODY_TITLE_MAX_BYTES,
    VETO_CONTENT_LIMIT_MARKER, VETO_ROW_LIMIT_MARKER,
};
use super::veto::{scene_body_declaration_veto, VetoLimits};
use crate::narrative_extraction::change_feed::CANONICAL_TEXT_NORMALIZER_VERSION;
use crate::narrative_extraction::read_narrative_scene_scope;
use crate::narrative_extraction::retrieval_admission::{
    read_retrieval_scene_source_bounded, RetrievalSceneSourceRead,
};
use crate::narrative_maintenance_connection::ParticipantSqlFence;
use crate::nir1_generation::{
    classify_store_error, ensure_no_nested_sql_owner, error_chain_contains, Nir1AdmissionSqlBudget,
    Nir1StoreFailure,
};
use crate::state::ActiveWorkspaceSnapshot;

/// A [`DeclareRefusal`] travelling through an `anyhow` error out of a
/// transaction closure.
#[derive(Debug)]
pub(super) struct RefusalError(pub DeclareRefusal);

impl fmt::Display for RefusalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "NEX_BODY_DECLARATION_REFUSED:{}", self.0.code())
    }
}

impl std::error::Error for RefusalError {}

pub(super) fn refuse<T>(refusal: DeclareRefusal) -> Result<T> {
    Err(anyhow::Error::new(RefusalError(refusal)))
}

fn refusal_of(error: &anyhow::Error) -> Option<DeclareRefusal> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<RefusalError>())
        .map(|refusal| refusal.0)
}

/// The refusal a failed transaction closure stands for: the domain refusal it
/// raised, else the typed store failure (`Invalid` is `Internal`).
pub(super) fn refusal_from_error(error: &anyhow::Error, cancel_requested: bool) -> DeclareRefusal {
    if let Some(refusal) = refusal_of(error) {
        return refusal;
    }
    match classify_store_error(error, cancel_requested) {
        Nir1StoreFailure::Invalid => DeclareRefusal::Internal,
        failure => DeclareRefusal::Store(failure),
    }
}

/// The workspace half of a binding, taken from the exact Ready binding the
/// snapshot was captured with.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct WorkspaceFacts {
    pub workspace_id: String,
    pub canonical_locator_digest: String,
    pub authority_instance: u64,
    pub recovery_generation: u64,
}

impl WorkspaceFacts {
    pub(super) fn from_snapshot(
        workspace: &ActiveWorkspaceSnapshot,
    ) -> Result<Self, DeclareRefusal> {
        let (Some(binding), Some(identity)) = (
            workspace.live_binding(),
            workspace.durable_workspace_identity(),
        ) else {
            return Err(DeclareRefusal::LocatorUnavailable);
        };
        Ok(Self {
            workspace_id: binding.workspace_id.to_string(),
            canonical_locator_digest: identity.canonical_locator_digest.as_str().to_owned(),
            authority_instance: binding.authority_instance,
            recovery_generation: binding.recovery_generation,
        })
    }
}

/// Refuses while a previous COMMIT of this workspace had an unknown outcome.
pub(super) fn ensure_not_quarantined(
    workspace: &ActiveWorkspaceSnapshot,
) -> Result<(), DeclareRefusal> {
    match workspace.durable_workspace_identity() {
        Some(identity) if is_scene_body_declaration_quarantined(identity) => {
            Err(DeclareRefusal::RestartRequired)
        }
        Some(_) => Ok(()),
        None => Err(DeclareRefusal::LocatorUnavailable),
    }
}

pub(super) fn ensure_no_sql_owner() -> Result<(), DeclareRefusal> {
    ensure_no_nested_sql_owner()
        .map_err(|_| DeclareRefusal::Store(Nir1StoreFailure::SqlOwnerActive))
}

/// The Scene's declaration token as the OCC sees it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum DeclarationOcc {
    /// No token (the declaration is absent; a lone JSON cell is overwritten by
    /// the next declaration and reads as nothing to revoke).
    None,
    Token(String),
    /// The token cell is not readable text within its limit. Neither a
    /// declaration nor a revoke can name it; a restore clears it.
    Unreadable,
}

pub(super) fn read_declaration_occ(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> Result<DeclarationOcc> {
    let shape: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT typeof(body_declaration_token), octet_length(body_declaration_token)
               FROM narrative_scene_scope_bindings
              WHERE project_id = ?1 AND scene_id = ?2",
            params![project_id, scene_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((storage_type, octets)) = shape else {
        return refuse(DeclareRefusal::ScopeUnavailable);
    };
    match storage_type.as_str() {
        "null" => Ok(DeclarationOcc::None),
        "text"
            if octets.is_some_and(|octets| {
                usize::try_from(octets)
                    .is_ok_and(|octets| octets <= MAX_NARRATIVE_SCENE_BODY_DECLARATION_TOKEN_BYTES)
            }) =>
        {
            let bytes: Vec<u8> = conn.query_row(
                "SELECT CAST(body_declaration_token AS BLOB)
                   FROM narrative_scene_scope_bindings
                  WHERE project_id = ?1 AND scene_id = ?2",
                params![project_id, scene_id],
                |row| row.get(0),
            )?;
            Ok(String::from_utf8(bytes)
                .map(DeclarationOcc::Token)
                .unwrap_or(DeclarationOcc::Unreadable))
        }
        _ => Ok(DeclarationOcc::Unreadable),
    }
}

/// The facts of one Scene, ready to be compared with a binding.
pub(super) struct SceneFacts {
    pub binding: BodyDeclarationBinding,
    pub display: BodyDeclarationDisplay,
}

fn unresolved_query(identity: &NarrativeSceneQueryIdentityV1) -> bool {
    is_unresolved(&identity.timeline)
        || is_unresolved(&identity.worldline)
        || is_unresolved(&identity.narrative_layer)
}

fn unresolved_material(constraint: &NarrativeSceneMaterialConstraintV1) -> bool {
    is_unresolved(&constraint.timeline)
        || is_unresolved(&constraint.worldline)
        || is_unresolved(&constraint.narrative_layer)
}

/// True when the Scene, or a folder above it (up to 256 levels), is archived.
/// The writer's preview and CB-4's reader share it, so the two cannot judge
/// liveness differently.
pub(in crate::narrative_extraction) fn archived_in_chain(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> Result<bool> {
    Ok(conn.query_row(
        "WITH RECURSIVE chain(id, parent_id, archived, depth) AS (
             SELECT id, parent_id, archived_at IS NOT NULL, 0
               FROM tree_nodes WHERE id = ?1 AND project_id = ?2
             UNION ALL
             SELECT t.id, t.parent_id, t.archived_at IS NOT NULL, c.depth + 1
               FROM tree_nodes t JOIN chain c ON t.id = c.parent_id
              WHERE t.project_id = ?2 AND c.depth < 256
         )
         SELECT COALESCE(MAX(archived), 0) FROM chain",
        params![scene_id, project_id],
        |row| row.get(0),
    )?)
}

/// Reads every fact a declaration is bound to, inside the caller's
/// transaction. Refuses with a closed [`DeclareRefusal`] (through
/// [`refuse`]) when the Scene cannot be declared.
pub(super) fn read_scene_facts_in_tx(
    conn: &Connection,
    workspace: &WorkspaceFacts,
    project_id: &str,
    scene_id: &str,
    values: &NarrativeSceneBodyDeclarationValuesV1,
    checkpoint: &mut dyn FnMut() -> Result<()>,
) -> Result<SceneFacts> {
    checkpoint()?;
    // The Scene, in this project, and the size of its title (before the title
    // is read).
    let title_octets: Option<i64> = conn
        .query_row(
            "SELECT octet_length(title) FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![scene_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(title_octets) = title_octets else {
        return refuse(DeclareRefusal::SceneNotFound);
    };
    // A Scene that is archived, or sits under an archived folder, is not live.
    if archived_in_chain(conn, project_id, scene_id)? {
        return refuse(DeclareRefusal::SceneArchived);
    }
    if usize::try_from(title_octets).map_or(true, |octets| octets > SCENE_BODY_TITLE_MAX_BYTES) {
        return refuse(DeclareRefusal::TitleTooLarge);
    }

    // A1: explicit and resolved.
    let scope = match read_narrative_scene_scope(conn, project_id, scene_id) {
        Ok(scope) => scope,
        Err(error) if classify_store_error(&error, false) == Nir1StoreFailure::Invalid => {
            return refuse(DeclareRefusal::ScopeUnavailable)
        }
        Err(error) => return Err(error),
    };
    let marker = scope.binding.compatibility_marker;
    if marker != NarrativeScopeCompatibilityMarkerV1::Explicit {
        return refuse(DeclareRefusal::ScopeNotExplicit);
    }
    if unresolved_query(&scope.binding.query_identity)
        || unresolved_material(&scope.binding.material_constraint)
    {
        return refuse(DeclareRefusal::ScopeUnresolved);
    }

    let declaration_token = match read_declaration_occ(conn, project_id, scene_id)? {
        DeclarationOcc::None => None,
        DeclarationOcc::Token(token) => Some(token),
        DeclarationOcc::Unreadable => return refuse(DeclareRefusal::DeclarationUnreadable),
    };

    let title: String = conn.query_row(
        "SELECT title FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
        params![scene_id, project_id],
        |row| row.get(0),
    )?;
    checkpoint()?;

    // The body, with its digests computed from the bytes read here.
    let source = match read_retrieval_scene_source_bounded(
        conn,
        project_id,
        scene_id,
        SCENE_BODY_READ_MAX_BYTES,
        SCENE_BODY_READ_MAX_BYTES,
        &mut || checkpoint(),
        &mut |peak| {
            ensure!(
                peak <= SCENE_BODY_READ_PEAK_MAX_BYTES,
                "NIR1_RETRIEVAL_SCENE_SOURCE_PEAK_LIMIT"
            );
            Ok(())
        },
    ) {
        Ok(RetrievalSceneSourceRead::Available(source)) => source,
        Ok(RetrievalSceneSourceRead::Unavailable { .. }) => {
            return refuse(DeclareRefusal::BodyUnreadable)
        }
        Err(error) if error_chain_contains(&error, "LIMIT") => {
            return refuse(DeclareRefusal::BodyTooLarge)
        }
        Err(error) if error_chain_contains(&error, "NEX_CANONICAL_TEXT_INVALID_JSON") => {
            return refuse(DeclareRefusal::BodyUnreadable)
        }
        Err(error) => return Err(error),
    };
    if source.archived {
        return refuse(DeclareRefusal::SceneArchived);
    }
    if source.canonical_source_text.trim().is_empty() {
        return refuse(DeclareRefusal::BodyEmpty);
    }
    let body_chars = u64::try_from(source.canonical_source_text.chars().count())?;
    let binding_source = NarrativeSceneBodySourceV1 {
        source_identity: source.query_source.source_key.clone(),
        source_token: source.query_source.revision_token.clone(),
        storage_digest: source.query_source.storage_digest.clone(),
        canonical_digest: source.query_source.canonical_text_digest.clone(),
        normalizer_version: CANONICAL_TEXT_NORMALIZER_VERSION.to_owned(),
        utf16_length: u64::try_from(source.query_source.canonical_utf16_length)?,
    };
    drop(source);
    checkpoint()?;

    match scene_body_declaration_veto(conn, project_id, scene_id, VetoLimits::DEFAULT) {
        Ok(None) => {}
        Ok(Some(veto)) => return refuse(DeclareRefusal::Veto(veto)),
        Err(error)
            if error_chain_contains(&error, VETO_ROW_LIMIT_MARKER)
                || error_chain_contains(&error, VETO_CONTENT_LIMIT_MARKER) =>
        {
            return refuse(DeclareRefusal::VetoLimit)
        }
        Err(error) => return Err(error),
    }
    checkpoint()?;

    let display = build_body_declaration_display(&title, body_chars)?;
    let binding = BodyDeclarationBinding {
        project_id: project_id.to_owned(),
        scene_id: scene_id.to_owned(),
        scene_incarnation_id: scope.binding.scene_incarnation_id.clone(),
        scope_version: scope.binding.version,
        scope_token: scope.binding.source_token.clone(),
        declaration_token,
        body_source: binding_source,
        title_digest: scene_body_title_digest(&title)?,
        workspace_id: workspace.workspace_id.clone(),
        canonical_locator_digest: workspace.canonical_locator_digest.clone(),
        authority_instance: workspace.authority_instance,
        recovery_generation: workspace.recovery_generation,
        values_digest: declaration_values_digest(values)?,
        display_digest: display.digest().to_owned(),
    };
    Ok(SceneFacts { binding, display })
}

/// What a successful preview returns to the grant code: the binding it holds
/// inside Native, and the text Main shows.
#[derive(Debug)]
pub struct BodyDeclarationPreview {
    pub binding: BodyDeclarationBinding,
    pub display: BodyDeclarationDisplay,
}

/// Compares what the author's screen read with the Scene's current state.
pub(super) fn check_expected_occ(
    request: &DeclareRequest,
    binding: &BodyDeclarationBinding,
) -> Result<(), DeclareRefusal> {
    if request.expected.scope_version != binding.scope_version {
        return Err(DeclareRefusal::StateChanged(StateComponent::ScopeVersion));
    }
    if request.expected.scope_token != binding.scope_token {
        return Err(DeclareRefusal::StateChanged(StateComponent::ScopeToken));
    }
    if request.expected.declaration_token != binding.declaration_token {
        return Err(DeclareRefusal::StateChanged(
            StateComponent::DeclarationToken,
        ));
    }
    Ok(())
}

/// Reads the Scene's current state in a bounded read transaction and returns
/// the binding and the confirmation text. Never writes. Refuses (and creates
/// nothing) when the request is invalid, the workspace is quarantined, the
/// Scene cannot be declared, or the author's screen is out of date.
pub fn preview_scene_body_declaration(
    workspace: &ActiveWorkspaceSnapshot,
    request: &DeclareRequest,
    budget: &Nir1AdmissionSqlBudget,
) -> Result<BodyDeclarationPreview, DeclareRefusal> {
    request.validate()?;
    ensure_no_sql_owner()?;
    ensure_not_quarantined(workspace)?;
    let facts_workspace = WorkspaceFacts::from_snapshot(workspace)?;
    let sql_budget = budget.sql_budget();
    let checkpoint_budget = sql_budget.clone();
    let participant = workspace.participant();
    let fence: ParticipantSqlFence = budget.fence();
    workspace
        .db()
        .db()
        .with_participant_read_transaction_bounded_in(participant, fence, sql_budget, |conn| {
            let mut checkpoint = || checkpoint_budget.check(participant);
            let facts = read_scene_facts_in_tx(
                conn,
                &facts_workspace,
                &request.project_id,
                &request.scene_id,
                &request.values,
                &mut checkpoint,
            )?;
            if let Err(refusal) = check_expected_occ(request, &facts.binding) {
                return refuse(refusal);
            }
            Ok(facts)
        })
        .map(|facts| BodyDeclarationPreview {
            binding: facts.binding,
            display: facts.display,
        })
        .map_err(|error| refusal_from_error(&error, budget.cancel_requested()))
}
