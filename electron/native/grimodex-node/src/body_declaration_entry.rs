//! The typed Native entries of the body declaration (CB-2, DR-CB2-1,
//! DR-CB2-8, DR-CB2-9), the read-only state entry of the author's screen
//! (CB-3, DR-CB3-1) and the Main-only grant calls that serve them.
//!
//! Every entry here runs inside a blocking section and follows one order:
//!
//! 1. `admit_publication_entry` (a restricted profile needs the registered
//!    caller of the active workspace; an unrestricted profile needs none);
//! 2. the pre-publication gate: a closed gate refuses before anything reads
//!    the workspace or its database;
//! 3. the payload, the active workspace, and the workspace the request named;
//! 4. the quarantine of a previous COMMIT of unknown outcome;
//! 5. (declaration only) the grant's consume, then the writer.
//!
//! The state entry (`state`) follows steps 1 to 4 and then only reads.
//!
//! A refusal reaches the caller as the error message
//! `NEX_BODY_DECLARATION_REFUSED:<code>` (a closed set of codes, see the db
//! layer's `DeclareRefusal`) or as `MAIN_GRANT_*` (see `GrantRefusal`). No
//! message names a target, a title, a body, a digest or an id.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use anyhow::anyhow;
use grimodex_db::narrative_extraction::scene_body_declaration::{
    declare_scene_body, is_workspace_scene_body_declaration_quarantined,
    preview_scene_body_declaration, read_scene_body_declaration_state, revoke_scene_body,
    BodyDeclarationState, BodyDeclarationStateRead, DeclareRefusal, DeclareRequest, RevokeRequest,
    StateRequest,
};
use grimodex_db::nir1_generation::{Nir1AdmissionProbe, Nir1AdmissionSqlBudget};
use grimodex_db::state::{active_workspace_snapshot, ActiveWorkspaceSnapshot};
use grimodex_db::workspace_lifecycle::{LifecycleState, LiveBinding};
use grimodex_db::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::convert::from_wire;
use crate::main_grant::{
    main_grant_digest, BodyDeclarationGrantPayload, BodyDeclarationKind, GrantPayload,
    GrantRefusal, MainGrantKind, PrePublicationEntry, PreviewInit,
};
use crate::state::AppState;
use crate::{admit_publication_entry, validate_narrative_extraction_workspace};

/// The wire request of the declaration entry and of a preview (the same
/// document: Main previews the request it is about to dispatch).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeclareWire {
    expected_workspace_path: String,
    payload: DeclareRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RevokeWire {
    expected_workspace_path: String,
    payload: RevokeRequest,
}

/// The wire request of the state read: the workspace the author's window
/// named and the two keys of the Scene it opened. It has no room for a grant,
/// a request ID or a declaration token.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateWire {
    expected_workspace_path: String,
    payload: StateRequest,
}

/// The out-of-band grant Main attaches to the declaration entry (a
/// non-enumerable sidecar, like the caller identity). A renderer cannot put one
/// into its payload: the payload types reject unknown fields.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantSidecar {
    grant_id: String,
    sender_id: u32,
    window_id: u32,
}

const MAX_GRANT_ID_BYTES: usize = 128;

fn refuse<T>(refusal: DeclareRefusal) -> Result<T, AppError> {
    Err(AppError::Anyhow(anyhow!(
        "NEX_BODY_DECLARATION_REFUSED:{}",
        refusal.code()
    )))
}

fn grant_error<T>(refusal: GrantRefusal) -> Result<T, AppError> {
    Err(AppError::Anyhow(refusal.into_error()))
}

fn require_gate(state: &AppState, entry: PrePublicationEntry) -> Result<(), AppError> {
    if state.main_grant.gate.is_open(entry) {
        Ok(())
    } else {
        refuse(DeclareRefusal::GateClosed)
    }
}

/// The admission budget of one entry. The probe turns false once a lifecycle
/// edge that stops work was observed after the budget was made, which fences
/// the writer's SQL (a write in flight rolls back before COMMIT).
fn admission_budget(state: &AppState, epoch: u64) -> Nir1AdmissionSqlBudget {
    let registry = Arc::clone(&state.main_grant.registry);
    let probe: Nir1AdmissionProbe = Arc::new(move || registry.edge_epoch() == epoch);
    Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), probe)
}

/// The Ready binding and revision of the lifecycle Core right now.
fn ready_lifecycle(state: &AppState) -> Result<(LiveBinding, u64), AppError> {
    let snapshot = state.workspace_lifecycle.lifecycle_snapshot()?;
    match snapshot.state {
        LifecycleState::Ready(binding) => Ok((binding, snapshot.revision)),
        _ => grant_error(GrantRefusal::Unavailable),
    }
}

fn open_workspace(
    state: &AppState,
    expected_workspace_path: &str,
) -> Result<ActiveWorkspaceSnapshot, AppError> {
    let workspace = active_workspace_snapshot(&state.ws)?;
    validate_narrative_extraction_workspace(&workspace, expected_workspace_path)?;
    Ok(workspace)
}

// ───────────────────────── the two typed entries ─────────────────────────

/// The declaration entry. It needs the grant Main attached; the grant is
/// consumed before the writer opens a transaction and is never given back.
pub(crate) fn declare(
    state: &Arc<AppState>,
    payload: Value,
    caller_identity: Option<String>,
    grant: Option<String>,
) -> Result<String, AppError> {
    admit_publication_entry(state, caller_identity)?;
    require_gate(state, PrePublicationEntry::SceneBodyDeclaration)?;
    let epoch = state.main_grant.registry.edge_epoch();
    let wire: DeclareWire = from_wire("payload", payload)?;
    let Some(sidecar) = grant else {
        return grant_error(GrantRefusal::Missing);
    };
    let sidecar: GrantSidecar = serde_json::from_str(&sidecar)
        .map_err(|_| AppError::Anyhow(GrantRefusal::Missing.into_error()))?;
    if sidecar.grant_id.is_empty() || sidecar.grant_id.len() > MAX_GRANT_ID_BYTES {
        return grant_error(GrantRefusal::Missing);
    }

    // Everything that can be refused without spending the grant comes first.
    // A refusal here frees the slot: nothing was written, so the author
    // starts again from a new confirmation.
    let registry = &state.main_grant.registry;
    let before_consume = || -> Result<(ActiveWorkspaceSnapshot, u64), AppError> {
        if let Err(refusal) = wire.payload.validate() {
            return refuse(refusal);
        }
        let workspace = open_workspace(state, &wire.expected_workspace_path)?;
        if is_workspace_scene_body_declaration_quarantined(&workspace) {
            return refuse(DeclareRefusal::RestartRequired);
        }
        let (_, revision) = ready_lifecycle(state)?;
        Ok((workspace, revision))
    };
    let (workspace, revision) = match before_consume() {
        Ok(ready) => ready,
        Err(error) => {
            registry.revoke(&sidecar.grant_id);
            return Err(error);
        }
    };

    let consumed = registry
        .consume::<BodyDeclarationKind>(
            &sidecar.grant_id,
            sidecar.sender_id,
            sidecar.window_id,
            revision,
        )
        .or_else(grant_error)?;
    let budget = admission_budget(state, epoch);
    // The workspace snapshot (the lifecycle participant) lives until the
    // writer has returned its terminal evidence.
    match declare_scene_body(&workspace, consumed, wire.payload, &budget) {
        Ok(outcome) => Ok(json!({ "outcome": outcome.response.code() }).to_string()),
        Err(failure) => refuse(failure.refusal),
    }
}

/// The revoke entry. It needs no grant (K2-3): it only removes a declaration.
pub(crate) fn revoke(
    state: &Arc<AppState>,
    payload: Value,
    caller_identity: Option<String>,
) -> Result<String, AppError> {
    admit_publication_entry(state, caller_identity)?;
    require_gate(state, PrePublicationEntry::SceneBodyDeclaration)?;
    let epoch = state.main_grant.registry.edge_epoch();
    let wire: RevokeWire = from_wire("payload", payload)?;
    let workspace = open_workspace(state, &wire.expected_workspace_path)?;
    let budget = admission_budget(state, epoch);
    match revoke_scene_body(&workspace, wire.payload, &budget) {
        Ok(outcome) => Ok(json!({ "outcome": outcome.response.code() }).to_string()),
        Err(failure) => refuse(failure.refusal),
    }
}

// ───────────────────────── the state read (CB-3) ─────────────────────────

/// The values the author's next declare has to name, read in the same snapshot
/// as the state. Opaque: nothing else about the Scene crosses.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateOccResponse {
    scope_version: i64,
    scope_token: String,
}

/// The closed answer. There is no field for a body, an excerpt, a title, a
/// digest, a locator, a workspace ID, a Scene ID, a declaration ID or a time.
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum StateBodyResponse {
    None {
        blocker: Option<&'static str>,
    },
    Declared {
        effective: bool,
        expired_by: Vec<&'static str>,
        blocker: Option<&'static str>,
    },
    Unavailable {
        reason: &'static str,
        blocker: Option<&'static str>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateResponse {
    occ: Option<StateOccResponse>,
    declaration_token: Option<String>,
    state: StateBodyResponse,
}

fn state_response(read: BodyDeclarationStateRead) -> StateResponse {
    let blocker = read.state.blocker().map(DeclareRefusal::code);
    let state = match read.state {
        BodyDeclarationState::None { .. } => StateBodyResponse::None { blocker },
        BodyDeclarationState::Declared {
            effective,
            expired_by,
            ..
        } => StateBodyResponse::Declared {
            effective,
            expired_by: expired_by.into_iter().map(|group| group.code()).collect(),
            blocker,
        },
        BodyDeclarationState::Unavailable { reason, .. } => StateBodyResponse::Unavailable {
            reason: reason.code(),
            blocker,
        },
    };
    StateResponse {
        occ: read.occ.map(|occ| StateOccResponse {
            scope_version: occ.scope_version,
            scope_token: occ.scope_token,
        }),
        declaration_token: read.declaration_token,
        state,
    }
}

/// Opens the active workspace for the state read. A workspace that is not the
/// one the request named, and a path that cannot be compared, are the same
/// closed code: no path or I/O error text reaches the caller.
fn open_workspace_for_state(
    state: &AppState,
    expected_workspace_path: &str,
) -> Result<ActiveWorkspaceSnapshot, AppError> {
    let workspace = active_workspace_snapshot(&state.ws)?;
    let matches = match (
        workspace.path().canonicalize(),
        std::path::Path::new(expected_workspace_path).canonicalize(),
    ) {
        (Ok(active), Ok(expected)) => active == expected,
        _ => false,
    };
    if matches {
        Ok(workspace)
    } else {
        refuse(DeclareRefusal::WorkspaceMismatch)
    }
}

/// The state read of the Scene the author opened. Read-only; it needs no
/// grant, and the same gate that closes the declaration closes it, before the
/// workspace or the database is touched.
pub(crate) fn state(
    state: &Arc<AppState>,
    payload: Value,
    caller_identity: Option<String>,
) -> Result<String, AppError> {
    admit_publication_entry(state, caller_identity)?;
    require_gate(state, PrePublicationEntry::SceneBodyDeclaration)?;
    let epoch = state.main_grant.registry.edge_epoch();
    let wire: StateWire = from_wire("payload", payload)?;
    let workspace = open_workspace_for_state(state, &wire.expected_workspace_path)?;
    let budget = admission_budget(state, epoch);
    match read_scene_body_declaration_state(&workspace, &wire.payload, &budget) {
        Ok(read) => serde_json::to_string(&state_response(read))
            .map_err(|error| AppError::Anyhow(anyhow::Error::from(error))),
        Err(refusal) => refuse(refusal),
    }
}

// ───────────────────────── Main-only grant calls ─────────────────────────

fn parse_kind(kind: &str) -> Result<MainGrantKind, AppError> {
    MainGrantKind::parse(kind).ok_or_else(|| AppError::Anyhow(anyhow!("MAIN_GRANT_KIND")))
}

/// Reads the Scene and stores a preview. Returns the dialog text Native built,
/// the previewId and the time left; nothing else crosses to Main.
pub(crate) fn grant_preview(
    state: &Arc<AppState>,
    kind: &str,
    request_json: &str,
    sender_id: u32,
    window_id: u32,
    caller_identity: Option<String>,
) -> Result<String, AppError> {
    let kind = parse_kind(kind)?;
    admit_publication_entry(state, caller_identity)?;
    require_gate(state, kind.gate_entry())?;
    let registry = &state.main_grant.registry;
    registry.ensure_can_preview().or_else(grant_error)?;
    let wire: DeclareWire = serde_json::from_str(request_json).map_err(|_| {
        AppError::Anyhow(anyhow!("invalid request: not a body declaration request"))
    })?;
    let epoch = registry.edge_epoch();

    let (binding_before, revision_before) = ready_lifecycle(state)?;
    let workspace = open_workspace(state, &wire.expected_workspace_path)?;
    let budget = admission_budget(state, epoch);
    let preview = match preview_scene_body_declaration(&workspace, &wire.payload, &budget) {
        Ok(preview) => preview,
        Err(refusal) => return refuse(refusal),
    };
    // The lifecycle did not move while the Scene was read, and the Scene's
    // workspace is the Ready one.
    let (binding_after, revision_after) = ready_lifecycle(state)?;
    let bound = &preview.binding;
    if revision_before != revision_after
        || binding_before.workspace_id.as_ref() != bound.workspace_id
        || binding_after.workspace_id.as_ref() != bound.workspace_id
        || binding_after.authority_instance != bound.authority_instance
        || binding_after.recovery_generation != bound.recovery_generation
    {
        return grant_error(GrantRefusal::StateChanged);
    }

    let digest = main_grant_digest(kind, bound, revision_after, sender_id, window_id)
        .map_err(AppError::Anyhow)?;
    let display = preview.display.text();
    let handle = registry
        .insert_preview(
            PreviewInit {
                kind,
                sender_id,
                window_id,
                digest,
                lifecycle_revision: revision_after,
                payload: GrantPayload::BodyDeclaration(Box::new(BodyDeclarationGrantPayload {
                    request: wire.payload,
                    expected_workspace_path: wire.expected_workspace_path,
                    binding: preview.binding,
                })),
            },
            epoch,
        )
        .or_else(grant_error)?;
    Ok(json!({
        "previewId": handle.preview_id,
        "display": display,
        "expiresInMs": handle.expires_in_ms,
    })
    .to_string())
}

/// Turns an approved preview into a grant, after reading the Scene again: a
/// change since the preview revokes the grant.
pub(crate) fn grant_issue(
    state: &Arc<AppState>,
    preview_id: &str,
    sender_id: u32,
    window_id: u32,
) -> Result<String, AppError> {
    let registry = &state.main_grant.registry;
    let epoch = registry.edge_epoch();
    let ticket = registry
        .begin_issue(preview_id, sender_id, window_id)
        .or_else(grant_error)?;
    let reread = || -> Result<String, AppError> {
        let GrantPayload::BodyDeclaration(payload) = &ticket.payload;
        require_gate(state, PrePublicationEntry::SceneBodyDeclaration)?;
        let (binding, revision) = ready_lifecycle(state)?;
        let workspace = open_workspace(state, &payload.expected_workspace_path)?;
        let budget = admission_budget(state, epoch);
        let current = preview_scene_body_declaration(&workspace, &payload.request, &budget)
            .map_err(|_| AppError::Anyhow(GrantRefusal::StateChanged.into_error()))?;
        if revision != ticket.lifecycle_revision
            || binding.workspace_id.as_ref() != current.binding.workspace_id
        {
            return grant_error(GrantRefusal::StateChanged);
        }
        main_grant_digest(
            MainGrantKind::BodyDeclaration,
            &current.binding,
            revision,
            ticket.sender_id,
            ticket.window_id,
        )
        .map_err(AppError::Anyhow)
    };
    let digest = match reread() {
        Ok(digest) => digest,
        Err(error) => {
            registry.revoke(preview_id);
            return Err(error);
        }
    };
    let grant_id = registry
        .finish_issue(preview_id, &digest)
        .or_else(grant_error)?;
    Ok(json!({ "grantId": grant_id }).to_string())
}
