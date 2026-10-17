//! Native admission for the `nir1-publication` and Scope entries (K3/2 "区分の
//! 意味"). Electron main attaches the issued caller identity out of band
//! (`callerIdentity`, a non-enumerable sidecar of the typed command) and the
//! N-API entry receives it as an optional trailing argument, so no typed
//! request changes its `deny_unknown_fields` shape.
//!
//! * An unrestricted profile admits every call unchecked (current behavior).
//! * A restricted profile needs the exact registered main-issued identity of
//!   the active workspace, with the stop barrier confirmed.
//! * `finish` is the return-time recheck: it fails closed when the caller
//!   registration, epoch, workspace or revocation generation changed, or when
//!   the profile became restricted meanwhile. The caller then discards its
//!   result. Scope entries admit only (no return recheck).
//!
//! Errors carry only the `D2A_EGRESS_DENIED` reason; they never include an
//! owner, ticket or identity.

use crate::{
    profile_egress::{CallerIdentity, PublicationAdmission, D2A_EGRESS_DENIED_MARKER},
    state::AppState,
};
use anyhow::{anyhow, Result};
use grimodex_db::state::active_workspace_snapshot;

pub(crate) struct PublicationGuard {
    identity: Option<CallerIdentity>,
    admission: PublicationAdmission,
}

impl PublicationGuard {
    /// Parse the wire identity and admit the call. A malformed identity is
    /// refused whatever the profile mode.
    pub(crate) fn admit(state: &AppState, wire: Option<String>) -> Result<Self> {
        let identity = wire
            .map(|serialized| {
                serde_json::from_str::<CallerIdentity>(&serialized)
                    .map_err(|_| anyhow!("{D2A_EGRESS_DENIED_MARKER} caller identity is malformed"))
            })
            .transpose()?;
        let workspace_id = pinned_workspace_id(state)?;
        let admission = state
            .profile_egress
            .admit_publication(identity.as_ref(), workspace_id.as_deref())?;
        Ok(Self {
            identity,
            admission,
        })
    }

    /// Return-time recheck. Call it after the result exists and before it is
    /// handed back; on error drop the result and release anything it owns.
    pub(crate) fn finish(&self, state: &AppState) -> Result<()> {
        let workspace_id = pinned_workspace_id(state)?;
        state.profile_egress.recheck_publication(
            self.admission,
            self.identity.as_ref(),
            workspace_id.as_deref(),
        )
    }
}

/// The workspace the identity must name: the active workspace path, the same
/// value the generic DB seam pins. Only a restricted profile looks it up.
fn pinned_workspace_id(state: &AppState) -> Result<Option<String>> {
    if !state.profile_egress.is_restricted() {
        return Ok(None);
    }
    let workspace = active_workspace_snapshot(&state.ws).map_err(|_| {
        anyhow!("{D2A_EGRESS_DENIED_MARKER} no active workspace for the caller identity")
    })?;
    Ok(Some(workspace.path().to_string_lossy().into_owned()))
}
