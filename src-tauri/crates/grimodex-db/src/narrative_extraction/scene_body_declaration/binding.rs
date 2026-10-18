//! Closed request, binding, response and refusal types of the body-declaration
//! entries (DR-CB2-1, DR-CB2-2).
//!
//! Everything here is a pure value. The payloads reject unknown fields, so a
//! declaration ID, a time, a digest, a grant or a sender in a renderer payload
//! is refused when it is parsed. The binding holds digests, counts and
//! identities only: no body text, no title text.

#![cfg_attr(not(feature = "native-current-human-capture"), allow(dead_code))]

use std::fmt;

use anyhow::Result;
use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_scene_body_declaration::{
    NarrativeSceneBodyDeclarationValuesV1, NarrativeSceneBodySourceV1,
    MAX_BODY_DECLARATION_ID_BYTES, MAX_NARRATIVE_SCENE_BODY_DECLARATION_TOKEN_BYTES,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};

use super::veto::BodyDeclarationVeto;
use crate::nir1_generation::Nir1StoreFailure;

/// Largest `requestId`.
pub const MAX_DECLARATION_REQUEST_ID_BYTES: usize = 128;

/// Domain of the idempotency ledger for the declaration entry.
pub(crate) const DECLARE_IDEMPOTENCY_DOMAIN: &str = "scene_body_declaration_declare";
/// Domain of the idempotency ledger for the revoke entry.
pub(crate) const REVOKE_IDEMPOTENCY_DOMAIN: &str = "scene_body_declaration_revoke";

const BINDING_DIGEST_DOMAIN: &str = "grimodex/body-declaration-binding/1";
const VALUES_DIGEST_DOMAIN: &str = "grimodex/body-declaration-values/1";

fn required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn u64_as_string<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

/// What the author's screen last read: the OCC of the declaration. `null` for
/// `declarationToken` states that the Scene has no declaration.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedDeclarationOcc {
    /// The v1 Scene Scope `version`.
    pub scope_version: i64,
    /// The v1 Scene Scope `source_token`.
    pub scope_token: String,
    #[serde(deserialize_with = "required_option")]
    pub declaration_token: Option<String>,
}

/// The declaration entry's payload. It has no field for a declaration ID, a
/// time, a digest, a grant, a sender or a window: those are never accepted.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclareRequest {
    pub project_id: String,
    pub scene_id: String,
    pub request_id: String,
    pub expected: ExpectedDeclarationOcc,
    /// The G-01 subset. A value outside it (or a missing axis) fails to parse.
    pub values: NarrativeSceneBodyDeclarationValuesV1,
}

/// The revoke entry's payload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokeRequest {
    pub project_id: String,
    pub scene_id: String,
    pub request_id: String,
    /// The token of the declaration to revoke.
    pub declaration_token: String,
}

fn bounded(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.trim() == value && value.len() <= max_bytes
}

fn common_identity_valid(project_id: &str, scene_id: &str, request_id: &str) -> bool {
    bounded(project_id, MAX_BODY_DECLARATION_ID_BYTES)
        && bounded(scene_id, MAX_BODY_DECLARATION_ID_BYTES)
        && bounded(request_id, MAX_DECLARATION_REQUEST_ID_BYTES)
}

impl DeclareRequest {
    pub fn validate(&self) -> Result<(), DeclareRefusal> {
        let token_ok =
            |token: &str| bounded(token, MAX_NARRATIVE_SCENE_BODY_DECLARATION_TOKEN_BYTES);
        if common_identity_valid(&self.project_id, &self.scene_id, &self.request_id)
            && self.expected.scope_version >= 1
            && token_ok(&self.expected.scope_token)
            && self
                .expected
                .declaration_token
                .as_deref()
                .is_none_or(token_ok)
        {
            Ok(())
        } else {
            Err(DeclareRefusal::InvalidRequest)
        }
    }
}

impl RevokeRequest {
    pub fn validate(&self) -> Result<(), DeclareRefusal> {
        if common_identity_valid(&self.project_id, &self.scene_id, &self.request_id)
            && bounded(
                &self.declaration_token,
                MAX_NARRATIVE_SCENE_BODY_DECLARATION_TOKEN_BYTES,
            )
        {
            Ok(())
        } else {
            Err(DeclareRefusal::InvalidRequest)
        }
    }
}

/// The digest of the declared values (a fixed value in v1: every axis has a
/// single accepted value).
pub fn declaration_values_digest(values: &NarrativeSceneBodyDeclarationValuesV1) -> Result<String> {
    Ok(canonical_json_digest(&json!({
        "domain": VALUES_DIGEST_DOMAIN,
        "values": serde_json::to_value(values)?,
    }))?)
}

/// Everything a Main confirmation is bound to, as Native read it in the
/// preview. Digests, counts and identities only. `authority_instance` and
/// `recovery_generation` are u64 values that stay inside Native: they are
/// serialized as decimal strings and never leave through a response.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyDeclarationBinding {
    pub project_id: String,
    pub scene_id: String,
    pub scene_incarnation_id: String,
    /// The v1 Scene Scope `version`.
    pub scope_version: i64,
    /// The v1 Scene Scope `source_token`.
    pub scope_token: String,
    /// The Scene's current declaration token, or `None` (no declaration).
    pub declaration_token: Option<String>,
    pub body_source: NarrativeSceneBodySourceV1,
    pub title_digest: String,
    pub workspace_id: String,
    pub canonical_locator_digest: String,
    #[serde(serialize_with = "u64_as_string")]
    pub authority_instance: u64,
    #[serde(serialize_with = "u64_as_string")]
    pub recovery_generation: u64,
    pub values_digest: String,
    pub display_digest: String,
}

impl BodyDeclarationBinding {
    /// Domain-separated digest of the binding's canonical JSON.
    pub fn digest(&self) -> Result<String> {
        Ok(canonical_json_digest(&json!({
            "domain": BINDING_DIGEST_DOMAIN,
            "binding": serde_json::to_value(self)?,
        }))?)
    }

    /// The first component of the binding that differs from `current`, in a
    /// fixed order. `None` means they are the same binding.
    pub(crate) fn first_difference(&self, current: &Self) -> Option<StateComponent> {
        let checks = [
            (
                self.workspace_id == current.workspace_id
                    && self.canonical_locator_digest == current.canonical_locator_digest
                    && self.authority_instance == current.authority_instance
                    && self.recovery_generation == current.recovery_generation,
                StateComponent::Workspace,
            ),
            (
                self.project_id == current.project_id && self.scene_id == current.scene_id,
                StateComponent::Request,
            ),
            (
                self.scene_incarnation_id == current.scene_incarnation_id,
                StateComponent::Incarnation,
            ),
            (
                self.scope_version == current.scope_version,
                StateComponent::ScopeVersion,
            ),
            (
                self.scope_token == current.scope_token,
                StateComponent::ScopeToken,
            ),
            (
                self.declaration_token == current.declaration_token,
                StateComponent::DeclarationToken,
            ),
            (
                self.body_source.source_identity == current.body_source.source_identity
                    && self.body_source.source_token == current.body_source.source_token,
                StateComponent::BodyToken,
            ),
            (
                self.body_source.storage_digest == current.body_source.storage_digest
                    && self.body_source.canonical_digest == current.body_source.canonical_digest
                    && self.body_source.normalizer_version
                        == current.body_source.normalizer_version
                    && self.body_source.utf16_length == current.body_source.utf16_length,
                StateComponent::BodyDigest,
            ),
            (
                self.title_digest == current.title_digest,
                StateComponent::TitleDigest,
            ),
            (
                self.values_digest == current.values_digest,
                StateComponent::Values,
            ),
        ];
        checks
            .into_iter()
            .find_map(|(same, component)| (!same).then_some(component))
    }
}

/// A binding whose grant was consumed. Only the grimodex-node grant code makes
/// one, after it checked the grant's kind, sender, window, expiry and state and
/// moved the grant to `Consumed`. It is not `Clone`: a writer takes it by
/// value, so one consumed grant authorizes one writer call.
#[derive(Debug)]
pub struct ConsumedBodyDeclarationBinding {
    binding: BodyDeclarationBinding,
}

impl ConsumedBodyDeclarationBinding {
    pub fn from_consumed_grant(binding: BodyDeclarationBinding) -> Self {
        Self { binding }
    }

    pub fn binding(&self) -> &BodyDeclarationBinding {
        &self.binding
    }
}

/// The component of the Scene's state or of the binding that changed between
/// the preview and the write. The outward code is the single `state-changed`;
/// the component is for tests and diagnostics counters.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StateComponent {
    Workspace,
    Request,
    Incarnation,
    ScopeVersion,
    ScopeToken,
    DeclarationToken,
    BodyToken,
    BodyDigest,
    TitleDigest,
    Values,
}

/// Why a declaration, its preview or a revoke was refused. A closed set. No
/// code names a target, a title, a body, a digest or a count. These codes are
/// returned only for the Scene the author chose (Mandatory defense 9).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeclareRefusal {
    /// The pre-publication gate is closed (decided by the Native entry; the db
    /// layer never reads it).
    GateClosed,
    /// A previous COMMIT of this workspace had an unknown outcome; writes stay
    /// refused until the process restarts.
    RestartRequired,
    WorkspaceMismatch,
    InvalidRequest,
    SceneNotFound,
    SceneArchived,
    ScopeUnavailable,
    ScopeNotExplicit,
    ScopeUnresolved,
    BodyEmpty,
    BodyTooLarge,
    BodyUnreadable,
    TitleTooLarge,
    LocatorUnavailable,
    Veto(BodyDeclarationVeto),
    VetoLimit,
    StateChanged(StateComponent),
    DisplayMismatch,
    RequestConflict,
    DeclarationUnreadable,
    /// COMMIT failed and the reread proved nothing was written.
    CommitFailed,
    Internal,
    Store(Nir1StoreFailure),
}

impl DeclareRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::GateClosed => "gate-closed",
            Self::RestartRequired => "restart-required",
            Self::WorkspaceMismatch => "workspace-mismatch",
            Self::InvalidRequest => "invalid-request",
            Self::SceneNotFound => "scene-not-found",
            Self::SceneArchived => "scene-archived",
            Self::ScopeUnavailable => "scope-unavailable",
            Self::ScopeNotExplicit => "scope-not-explicit",
            Self::ScopeUnresolved => "scope-unresolved",
            Self::BodyEmpty => "body-empty",
            Self::BodyTooLarge => "body-too-large",
            Self::BodyUnreadable => "body-unreadable",
            Self::TitleTooLarge => "title-too-large",
            Self::LocatorUnavailable => "locator-unavailable",
            Self::Veto(veto) => veto.code(),
            Self::VetoLimit => "veto-limit",
            Self::StateChanged(_) => "state-changed",
            Self::DisplayMismatch => "display-mismatch",
            Self::RequestConflict => "request-conflict",
            Self::DeclarationUnreadable => "declaration-unreadable",
            Self::CommitFailed => "commit-failed",
            Self::Internal => "internal",
            Self::Store(failure) => failure.code(),
        }
    }
}

impl fmt::Display for DeclareRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for DeclareRefusal {}

/// The only response of a successful declaration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeclareResponse {
    Declared,
}

impl DeclareResponse {
    pub fn code(self) -> &'static str {
        "declared"
    }

    pub(crate) fn recorded(self) -> Value {
        json!({ "outcome": self.code() })
    }

    pub(crate) fn from_recorded(value: &Value) -> Option<Self> {
        (value.get("outcome").and_then(Value::as_str) == Some("declared")
            && value.as_object().is_some_and(|object| object.len() == 1))
        .then_some(Self::Declared)
    }
}

/// The response of a revoke.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RevokeResponse {
    Revoked,
    NoDeclaration,
    DeclarationChanged,
}

impl RevokeResponse {
    pub fn code(self) -> &'static str {
        match self {
            Self::Revoked => "revoked",
            Self::NoDeclaration => "no-declaration",
            Self::DeclarationChanged => "declaration-changed",
        }
    }

    pub(crate) fn recorded(self) -> Value {
        json!({ "outcome": self.code() })
    }

    pub(crate) fn from_recorded(value: &Value) -> Option<Self> {
        (value.get("outcome").and_then(Value::as_str) == Some("revoked")
            && value.as_object().is_some_and(|object| object.len() == 1))
        .then_some(Self::Revoked)
    }
}
