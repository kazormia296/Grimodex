//! The state of a Scene's body declaration, for the author's screen (CB-3,
//! DR-CB3-1).
//!
//! [`read_scene_body_declaration_state`] reads, in one bounded read
//! transaction, the stored declaration, the Scene's current facts and the
//! comparison of the two, and answers with a closed set: no declaration
//! (`None`), a stored declaration that does or does not hold now (`Declared`),
//! or a stored cell that cannot be used (`Unavailable`). It also returns the
//! values the author's next declare or revoke has to name (the OCC), read in
//! the same snapshot, so a screen built on this answer is as current as the
//! answer.
//!
//! It adds no rule of its own. The Scene's facts are read by the same
//! [`read_scene_facts_in_tx`] the preview and the writer use, unchanged, so a
//! refusal there (archived, A1 not explicit, empty body, veto, ...) is the
//! `blocker` here, with the same code the preview would refuse with. When
//! nothing blocks, the binding is compared with
//! [`scene_body_declaration_binding_mismatches`], the function CB-4's reader
//! uses. A declaration is `effective` exactly when the stored declaration is
//! readable, nothing blocks and every component of the binding holds. Those
//! are the conditions of the reader that do not depend on a query; the reader
//! adds the query-dependent ones (reading order, the path, the shared slot),
//! which this answer never claims.
//!
//! The answer carries no body, excerpt, title, digest, locator, workspace ID,
//! Scene ID or declaration ID. The only opaque values are the OCC tokens. It
//! writes nothing: not the two declaration columns, not the v1 columns, not
//! the feed, not the idempotency ledger, not `tree_nodes`.

use std::fmt;

use anyhow::Result;
use grimodex_core::narrative_scene_body_declaration::NarrativeSceneBodyDeclarationValuesV1;

use super::binding::{DeclareRefusal, StateRequest};
use super::commit_outcome::is_scene_body_declaration_quarantined;
use super::facts::{
    ensure_no_sql_owner, read_declaration_occ, read_scene_facts_in_tx, refusal_from_error,
    DeclarationOcc, RefusalError, SceneFacts, WorkspaceFacts,
};
use super::{
    read_scene_body_declaration, scene_body_declaration_binding_mismatches,
    SceneBodyDeclarationBindingMismatch, SceneBodyDeclarationCurrentFacts,
    SceneBodyDeclarationRead, SceneBodyDeclarationUnavailableReason,
};
use crate::nir1_generation::Nir1AdmissionSqlBudget;
use crate::state::ActiveWorkspaceSnapshot;

/// Why a stored declaration no longer holds, in four groups. A closed set that
/// names no component's value. Several can hold at once.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ExpiryGroup {
    /// The body Source (identity, token or digests) or the title changed.
    Content,
    /// The Scene's v1 Scope token moved (A1, the registry, a move between
    /// folders, POV, ...).
    Scope,
    /// The project, the Scene or the Scene's incarnation is another one.
    Identity,
    /// The workspace ID or the canonical locator is another one.
    Workspace,
}

impl ExpiryGroup {
    pub fn code(self) -> &'static str {
        match self {
            Self::Content => "content",
            Self::Scope => "scope",
            Self::Identity => "identity",
            Self::Workspace => "workspace",
        }
    }
}

/// The group a mismatching component of the binding belongs to.
pub fn expiry_group(mismatch: SceneBodyDeclarationBindingMismatch) -> ExpiryGroup {
    use SceneBodyDeclarationBindingMismatch as Mismatch;
    match mismatch {
        Mismatch::BodySourceIdentity
        | Mismatch::BodySourceToken
        | Mismatch::BodySourceDigest
        | Mismatch::TitleDigest => ExpiryGroup::Content,
        Mismatch::ScopeSourceToken => ExpiryGroup::Scope,
        Mismatch::ProjectId | Mismatch::SceneId | Mismatch::SceneIncarnation => {
            ExpiryGroup::Identity
        }
        Mismatch::WorkspaceId | Mismatch::CanonicalLocatorDigest => ExpiryGroup::Workspace,
    }
}

/// The state of the Scene's declaration. A `blocker` is the code the preview
/// would refuse a declaration with right now (never a code about Graph reach,
/// candidates or a query); `None` means nothing blocks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BodyDeclarationState {
    /// Both declaration columns are NULL.
    None { blocker: Option<DeclareRefusal> },
    /// A declaration is stored and readable. `effective` is true only when
    /// nothing blocks and every component of its binding holds. With a
    /// blocker `effective` is false and `expired_by` is empty (the reason is
    /// the blocker); otherwise `expired_by` lists the groups that differ, in
    /// the order of [`ExpiryGroup`], and is empty exactly when `effective`.
    Declared {
        effective: bool,
        expired_by: Vec<ExpiryGroup>,
        blocker: Option<DeclareRefusal>,
    },
    /// A cell is stored but cannot be used (see the reason). It is never
    /// effective. The cell's content is not returned.
    Unavailable {
        reason: SceneBodyDeclarationUnavailableReason,
        blocker: Option<DeclareRefusal>,
    },
}

impl BodyDeclarationState {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::None { .. } => "none",
            Self::Declared { .. } => "declared",
            Self::Unavailable { .. } => "unavailable",
        }
    }

    /// True only for a stored declaration that holds now.
    pub fn is_effective(&self) -> bool {
        matches!(
            self,
            Self::Declared {
                effective: true,
                ..
            }
        )
    }

    pub fn blocker(&self) -> Option<DeclareRefusal> {
        match self {
            Self::None { blocker }
            | Self::Declared { blocker, .. }
            | Self::Unavailable { blocker, .. } => *blocker,
        }
    }
}

/// What the next declare has to name (`ExpectedDeclarationOcc`), read in the
/// same snapshot as the state. Present only when the Scene's facts could be
/// read (nothing blocks a declaration).
#[derive(Clone, Eq, PartialEq)]
pub struct StateOcc {
    pub scope_version: i64,
    pub scope_token: String,
}

impl fmt::Debug for StateOcc {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("StateOcc").finish_non_exhaustive()
    }
}

/// The answer of [`read_scene_body_declaration_state`].
#[derive(Clone, Eq, PartialEq)]
pub struct BodyDeclarationStateRead {
    pub occ: Option<StateOcc>,
    /// The token a revoke has to name: the stored token cell, when it is
    /// readable text. `None` when there is nothing to revoke (or the cell
    /// cannot be read).
    pub declaration_token: Option<String>,
    pub state: BodyDeclarationState,
}

impl fmt::Debug for BodyDeclarationStateRead {
    // Neither the tokens nor any other value is printed.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BodyDeclarationStateRead")
            .field("state", &self.state)
            .field("has_occ", &self.occ.is_some())
            .field("has_declaration_token", &self.declaration_token.is_some())
            .finish()
    }
}

/// Refusals of the facts read that are a state of the Scene rather than a
/// failure: the preview refuses a declaration with exactly these.
fn is_state_blocker(refusal: DeclareRefusal) -> bool {
    matches!(
        refusal,
        DeclareRefusal::SceneNotFound
            | DeclareRefusal::SceneArchived
            | DeclareRefusal::ScopeUnavailable
            | DeclareRefusal::ScopeNotExplicit
            | DeclareRefusal::ScopeUnresolved
            | DeclareRefusal::BodyEmpty
            | DeclareRefusal::BodyTooLarge
            | DeclareRefusal::BodyUnreadable
            | DeclareRefusal::TitleTooLarge
            | DeclareRefusal::LocatorUnavailable
            | DeclareRefusal::Veto(_)
            | DeclareRefusal::VetoLimit
            | DeclareRefusal::DeclarationUnreadable
    )
}

/// The result of the shared facts read: the facts, or the state-like refusal.
enum FactsRead {
    Facts(Box<SceneFacts>),
    Blocked(DeclareRefusal),
}

fn read_facts(
    conn: &rusqlite::Connection,
    workspace: &Result<WorkspaceFacts, DeclareRefusal>,
    request: &StateRequest,
    checkpoint: &mut dyn FnMut() -> Result<()>,
) -> Result<FactsRead> {
    let workspace = match workspace {
        Ok(workspace) => workspace,
        Err(refusal) => return Ok(FactsRead::Blocked(*refusal)),
    };
    // The values only feed the digest the confirmation would be bound to; this
    // read never uses it.
    let values = NarrativeSceneBodyDeclarationValuesV1::g01();
    match read_scene_facts_in_tx(
        conn,
        workspace,
        &request.project_id,
        &request.scene_id,
        &values,
        checkpoint,
    ) {
        Ok(facts) => Ok(FactsRead::Facts(Box::new(facts))),
        Err(error) => {
            let refusal = error
                .chain()
                .find_map(|cause| cause.downcast_ref::<RefusalError>())
                .map(|refusal| refusal.0);
            match refusal {
                Some(refusal) if is_state_blocker(refusal) => Ok(FactsRead::Blocked(refusal)),
                // A control failure (cancel, deadline, fence), a storage
                // failure or a refusal that is not about the Scene: no
                // partial result.
                _ => Err(error),
            }
        }
    }
}

fn current_facts_of(facts: &SceneFacts) -> SceneBodyDeclarationCurrentFacts {
    let binding = &facts.binding;
    SceneBodyDeclarationCurrentFacts {
        project_id: binding.project_id.clone(),
        scene_id: binding.scene_id.clone(),
        scene_incarnation_id: binding.scene_incarnation_id.clone(),
        scope_source_token: binding.scope_token.clone(),
        body_source: binding.body_source.clone(),
        title_digest: binding.title_digest.clone(),
        workspace_id: binding.workspace_id.clone(),
        canonical_locator_digest: binding.canonical_locator_digest.clone(),
    }
}

/// The readable token cell of a Scene whose facts could not be read.
fn token_cell(conn: &rusqlite::Connection, request: &StateRequest) -> Result<Option<String>> {
    match read_declaration_occ(conn, &request.project_id, &request.scene_id) {
        Ok(DeclarationOcc::Token(token)) => Ok(Some(token)),
        Ok(DeclarationOcc::None | DeclarationOcc::Unreadable) => Ok(None),
        Err(error) => {
            if error
                .chain()
                .any(|cause| cause.downcast_ref::<RefusalError>().is_some())
            {
                // The Scene has no binding row: nothing to name.
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

fn read_state_in_tx(
    conn: &rusqlite::Connection,
    workspace: &Result<WorkspaceFacts, DeclareRefusal>,
    request: &StateRequest,
    checkpoint: &mut dyn FnMut() -> Result<()>,
) -> Result<BodyDeclarationStateRead> {
    checkpoint()?;
    let stored = read_scene_body_declaration(conn, &request.project_id, &request.scene_id)?;
    checkpoint()?;
    let facts = read_facts(conn, workspace, request, checkpoint)?;
    checkpoint()?;

    let (occ, blocker, declaration_token) = match &facts {
        FactsRead::Facts(facts) => (
            Some(StateOcc {
                scope_version: facts.binding.scope_version,
                scope_token: facts.binding.scope_token.clone(),
            }),
            None,
            facts.binding.declaration_token.clone(),
        ),
        FactsRead::Blocked(refusal) => {
            let token = match &stored {
                SceneBodyDeclarationRead::Declared(declared) => Some(declared.token.clone()),
                SceneBodyDeclarationRead::None => None,
                SceneBodyDeclarationRead::Unavailable(_) => token_cell(conn, request)?,
            };
            (None, Some(*refusal), token)
        }
    };

    let state = match stored {
        SceneBodyDeclarationRead::None => BodyDeclarationState::None { blocker },
        SceneBodyDeclarationRead::Unavailable(reason) => BodyDeclarationState::Unavailable {
            reason,
            // The reason already says the cell is unusable.
            blocker: blocker.filter(|b| *b != DeclareRefusal::DeclarationUnreadable),
        },
        SceneBodyDeclarationRead::Declared(declared) => match &facts {
            FactsRead::Blocked(refusal) => BodyDeclarationState::Declared {
                effective: false,
                expired_by: Vec::new(),
                blocker: Some(*refusal),
            },
            FactsRead::Facts(facts) => {
                let mut groups: Vec<ExpiryGroup> = scene_body_declaration_binding_mismatches(
                    &declared.declaration,
                    &current_facts_of(facts),
                )
                .into_iter()
                .map(expiry_group)
                .collect();
                groups.sort();
                groups.dedup();
                BodyDeclarationState::Declared {
                    effective: groups.is_empty(),
                    expired_by: groups,
                    blocker: None,
                }
            }
        },
    };
    Ok(BodyDeclarationStateRead {
        occ,
        declaration_token,
        state,
    })
}

/// Reads the state of a Scene's declaration in one bounded read transaction.
/// Never writes. Refuses (and reads nothing) when the request is invalid or
/// the workspace is quarantined (`restart-required`); a Scene that cannot be
/// declared is not a refusal but a `blocker` of the answer. A control failure
/// (cancel, deadline, lifecycle edge) or a storage failure is a refusal with no
/// partial result.
pub fn read_scene_body_declaration_state(
    workspace: &ActiveWorkspaceSnapshot,
    request: &StateRequest,
    budget: &Nir1AdmissionSqlBudget,
) -> Result<BodyDeclarationStateRead, DeclareRefusal> {
    request.validate()?;
    ensure_no_sql_owner()?;
    // A quarantined workspace is refused before the database is read. A
    // workspace without a durable identity cannot be quarantined; its answer
    // carries the `locator-unavailable` blocker instead.
    if workspace
        .durable_workspace_identity()
        .is_some_and(is_scene_body_declaration_quarantined)
    {
        return Err(DeclareRefusal::RestartRequired);
    }
    let facts_workspace = WorkspaceFacts::from_snapshot(workspace);
    let sql_budget = budget.sql_budget();
    let checkpoint_budget = sql_budget.clone();
    let participant = workspace.participant();
    let fence = budget.fence();
    workspace
        .db()
        .db()
        .with_participant_read_transaction_bounded_in(participant, fence, sql_budget, |conn| {
            let mut checkpoint = || checkpoint_budget.check(participant);
            read_state_in_tx(conn, &facts_workspace, request, &mut checkpoint)
        })
        .map_err(|error| refusal_from_error(&error, budget.cancel_requested()))
}
