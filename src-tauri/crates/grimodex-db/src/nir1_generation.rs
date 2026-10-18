//! Native-only durable generation observations and reference lineage.
//!
//! These operations do not authorize a model call or qualify history. In
//! particular, a claim is only a durable one-shot CAS. The writers below are
//! bounded (connection mutex, SQLite busy and per-operation limits) and run
//! COMMIT without any Core, profile or participant guard held. The Native
//! owner fences create/claim with its startup lease and the profile permit
//! (atomic pre-commit checks plus an admission probe), then revalidates the
//! profile, route, workspace, lease and cancel after COMMIT and before it
//! starts a transport. Create and claim also re-read the chat session and the
//! query Scene incarnation (`AttemptBinding` v2) inside their own IMMEDIATE
//! transaction, so a claim's CAS commits in the transaction that checked them.
//! No operation here resends.

use anyhow::{ensure, Context, Result};
use grimodex_core::narrative_nir1::MAX_PACKING_INPUT_BYTES;
use grimodex_core::narrative_nir1_receipt::{
    validate_terminal_matrix, Completion, OutputChannel, OutputObserver, ParseStatus,
    ProviderTerminal, TerminalObservation, TerminalStatus, OUTPUT_DIGEST_VERSION,
};
use grimodex_core::{canonical_json_digest, canonical_json_string};
use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::narrative_extraction::nir1_capacity::{
    check_active_capacity, with_capacity_scope, CapacityBudget,
};
use crate::narrative_extraction::{
    validation_terminated, with_immediate_transaction, GraphWorkControl, GraphWorkStage,
    ValidationTerminated, ValidationTerminationReason,
};
use crate::narrative_maintenance_connection::{
    ParticipantSqlControl, ParticipantSqlFence, ParticipantSqlOperationBudget,
    NIR1_SQL_CONNECTION_LOCK_TIMEOUT,
};
use crate::state::ActiveWorkspaceSnapshot;
use crate::Database;

mod local_audit_writer;
mod project_ai_policy;
pub use local_audit_writer::{
    append_local_audit_start_bounded, finish_attempt_with_audit_bounded, Nir1LocalAuditObserved,
    Nir1LocalAuditStart, Nir1LocalAuditStarted,
};
use local_audit_writer::{close_execution_in_tx, finish_attempt_bounded_with, AuditClose};
pub use project_ai_policy::{read_project_ai_policy_bounded, Nir1ProjectAiPolicyRead};
pub mod history_context;
pub(crate) mod history_reads;
use history_context::{
    eligible_until_ms, DurableWorkspaceIdentity, HistoryContextGateReason, HistoryContextSlot,
    HistoryUnavailableReason, SLOT_UNWRITABLE_ERROR,
};
use history_reads::{ExcludedHistoryAttempt, GenerationHistoryAttempt};

// These are storage safety ceilings for malformed/imported rows. They bound
// one Native materialization; they are not the owning turn's history or
// transport capacity contract.
const MAX_ID_BYTES: usize = 4 * 1024;
const MAX_BINDING_JSON_BYTES: usize = 64 * 1024;
const MAX_TERMINAL_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_MESSAGE_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_MESSAGE_METADATA_BYTES: usize = 2 * 1024 * 1024;
const MAX_SHORT_TEXT_BYTES: usize = 256;
const MAX_DIGEST_BYTES: usize = 128;
const ATTEMPT_MISSING_ERROR: &str = "NIR1_GENERATION_ATTEMPT_MISSING";
const MAX_RECOVERY_PAGE_SIZE: usize = 64;

/// The read-only history callback observes the same owner cancellation token
/// as the SQLite progress hook.  It never touches the lifecycle or database
/// mutex, so JSON parsing checkpoints remain safe inside the outer scope.
#[derive(Clone, Debug)]
pub(crate) struct GenerationHistorySnapshotCancellation {
    stop: Arc<AtomicBool>,
    deadline: Option<Instant>,
}

impl GenerationHistorySnapshotCancellation {
    pub(crate) fn from_control(control: &ParticipantSqlControl) -> Self {
        Self {
            stop: Arc::clone(&control.stop),
            deadline: control.deadline,
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.stop.load(Ordering::Acquire)
            || self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
    }

    pub(crate) fn checkpoint(&self) -> Result<()> {
        let reason = if self.stop.load(Ordering::Acquire) {
            Some(ValidationTerminationReason::Cancelled)
        } else if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            Some(ValidationTerminationReason::TimedOut)
        } else {
            None
        };
        if let Some(reason) = reason {
            return Err(validation_terminated(
                reason,
                "generation history snapshot owner stopped the read",
            ));
        }
        Ok(())
    }
}

fn bounded_sqlite_length(length: i64, limit: usize, error: &str) -> Result<usize> {
    ensure!(length >= 0, "{}", error);
    let length = usize::try_from(length).map_err(|_| anyhow::anyhow!("{error}"))?;
    ensure!(length <= limit, "{}", error);
    Ok(length)
}

fn bounded_optional_sqlite_length(
    length: Option<i64>,
    limit: usize,
    error: &str,
) -> Result<Option<usize>> {
    length
        .map(|length| bounded_sqlite_length(length, limit, error))
        .transpose()
}

fn is_confirmed_missing_attempt(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string() == ATTEMPT_MISSING_ERROR)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GenerationPurpose {
    Writing,
    Review,
}

/// The only binding format this build writes. Stored rows are read through
/// `parse_attempt_binding`, which admits legacy v1 rows for terminalization
/// only and rejects every other version.
const ATTEMPT_BINDING_VERSION: u64 = 2;
const BINDING_VERSION_UNSUPPORTED_ERROR: &str = "NIR1_GENERATION_BINDING_VERSION_UNSUPPORTED";
const BINDING_LEGACY_TERMINAL_ONLY_ERROR: &str = "NIR1_GENERATION_BINDING_LEGACY_TERMINAL_ONLY";
const REFERENCE_LEGACY_TERMINAL_ONLY_ERROR: &str = "NIR1_GENERATION_REFERENCE_LEGACY_TERMINAL_ONLY";

/// `bindingVersion` of [`AttemptBinding`]. It serializes as the integer 2,
/// and every other value fails to deserialize.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttemptBindingVersion {
    V2,
}

impl Serialize for AttemptBindingVersion {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::V2 => serializer.serialize_u64(ATTEMPT_BINDING_VERSION),
        }
    }
}

impl<'de> Deserialize<'de> for AttemptBindingVersion {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        if u64::deserialize(deserializer)? == ATTEMPT_BINDING_VERSION {
            Ok(Self::V2)
        } else {
            Err(serde::de::Error::custom(BINDING_VERSION_UNSUPPORTED_ERROR))
        }
    }
}

/// Exact Native-owned identities of one attempt (binding format v2).
/// Endpoint identity is a credential-free digest, never a URL. The opaque
/// workspace identity includes the existing authority instance/recovery
/// generation, not merely a project or path.
///
/// Storage re-reads `project_id`, `chat_session_id` and `scene` from the
/// current rows inside the IMMEDIATE transaction of create and claim.
/// `caller`, `workspace_binding_digest` and `route_revision` are
/// process-local: storage keeps them and compares them with the claimant's
/// binding, and the Native owner compares them with its live caller
/// registration, LiveBinding and route before it claims. The remaining
/// digests and route fields are coordinator-supplied proof inputs.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptBinding {
    pub binding_version: AttemptBindingVersion,
    pub project_id: String,
    /// The `chat_sessions` row; the attempt row stores it as `session_id`.
    pub chat_session_id: String,
    pub scene: AttemptSceneBinding,
    pub caller: AttemptCallerBinding,
    pub workspace_binding_digest: String,
    pub route_revision: String,
    pub purpose: GenerationPurpose,
    pub scope_digest: String,
    pub material_digest: String,
    pub d1_digest: String,
    pub provider: String,
    pub model: String,
    pub api: String,
    pub endpoint_identity: String,
    /// The turn's history context (K4/3 section 2). `None` is JSON null:
    /// a row written before HS-1 or by test-support, not usable as history.
    /// The product writer stores a context or a closed unavailable reason.
    pub history_turn_context: Option<HistoryContextSlot>,
    /// The durable workspace identity; `None` when it could not be
    /// determined or was dropped by the `binding-limit` downgrade.
    pub durable_workspace_identity: Option<DurableWorkspaceIdentity>,
}

/// The Main-issued caller that Native registered for the profile. It is
/// process-local: it is not persisted as an authority and a restart
/// invalidates it, so storage can only compare it with the claimant's value.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptCallerBinding {
    pub profile_id: String,
    pub caller_id: String,
    pub caller_epoch: u64,
    /// Main's per-sender `sessionId`. Deliberately not a chat session.
    pub caller_session_id: String,
}

/// The exact query Scene incarnation a request was prepared from, read with
/// `read_attempt_scene_binding_in_tx`. The `v{version}@{updated_at}` token
/// alone repeats across delete/recreate, snapshot restore and id reuse, so the
/// incarnation, the stored body digest and the live, unarchived state are
/// bound with it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptSceneBinding {
    pub scene_id: String,
    /// `narrative_scene_scope_bindings.scene_incarnation_id`. The Native writer
    /// mints it for every Scene row; it is never derived from the id, title
    /// or body.
    pub scene_incarnation_id: String,
    /// `v{version}@{updated_at}` of the `tree_nodes` row.
    pub source_token: String,
    /// `sha256:` + hex SHA-256 of the stored `tree_nodes.content` bytes.
    pub body_digest: String,
}

/// Binding format v1: rows written before `bindingVersion` existed. It has no
/// Scene binding, and its one `sessionId` mixed the chat session with the Main
/// caller session. Such a row may only be terminalized (recovery or a
/// non-success finish); it is never claimed, dispatched, used as a parent or
/// read as history.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyAttemptBindingV1 {
    project_id: String,
    session_id: String,
    profile_id: String,
    caller_id: String,
    caller_epoch: u64,
    workspace_binding_digest: String,
    purpose: GenerationPurpose,
    scope_digest: String,
    material_digest: String,
    d1_digest: String,
    route_revision: String,
    provider: String,
    model: String,
    api: String,
    endpoint_identity: String,
}

#[derive(Debug)]
enum VersionedAttemptBinding {
    LegacyV1(LegacyAttemptBindingV1),
    Current(AttemptBinding),
}

/// Reads only `bindingVersion`. Other keys are skipped, and a duplicated
/// `bindingVersion` key is a parse error.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttemptBindingVersionProbe {
    #[serde(default)]
    binding_version: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputRole {
    System,
    User,
    Assistant,
    Context,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InputTarget {
    Message {
        version_id: String,
        parent_attempt_id: Option<String>,
    },
    Artifact {
        artifact_id: String,
        payload_digest: String,
    },
    RawSource {
        source_key: String,
        revision_token: String,
    },
    AcceptedRevision {
        revision_id: String,
        bundle_digest: String,
    },
    GraphEvidence {
        evidence_ref: String,
        source_key: String,
        revision_token: String,
    },
}

/// `referenceVersion` of the per-input reference rows (`reference_json` of
/// `nir1_generation_input_refs` and `nir1_generation_qualification_refs`).
/// Version 1 rows have no such key and are read for terminalization and
/// recovery only. This build writes version 2 and rejects every other value.
const REFERENCE_VERSION: u64 = 2;
const REFERENCE_VERSION_UNSUPPORTED_ERROR: &str = "NIR1_GENERATION_REFERENCE_VERSION_UNSUPPORTED";
const REFERENCE_FORMAT_MIXED_ERROR: &str = "NIR1_GENERATION_REFERENCE_FORMAT_MIXED";
const REFERENCE_INVALID_ERROR: &str = "NIR1_GENERATION_REFERENCE_INVALID";
/// Domain of the final input digest over version 2 reference rows.
pub const INPUT_DIGEST_DOMAIN: &str = "nir1-generation-inputs@2";
/// Domain of the digest over version 1 reference rows (read-only).
const LEGACY_INPUT_DIGEST_DOMAIN_V1: &str = "nir1-generation-inputs@1";
/// Domain of the D1 selection digest (`d1_selection_digest`).
pub const D1_SELECTION_DIGEST_DOMAIN: &str = "nir1-generation-d1-selection@1";
/// Identity of the D1 qualification reference; its version is the selection
/// digest.
pub const D1_SELECTION_IDENTITY: &str = "d1-selection";

/// `referenceVersion` of a version 2 reference row. It serializes as the
/// integer 2, and every other value fails to deserialize.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ReferenceVersionV2;

impl Serialize for ReferenceVersionV2 {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_u64(REFERENCE_VERSION)
    }
}

impl<'de> Deserialize<'de> for ReferenceVersionV2 {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        if u64::deserialize(deserializer)? == REFERENCE_VERSION {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(
                REFERENCE_VERSION_UNSUPPORTED_ERROR,
            ))
        }
    }
}

/// How the reference rows of a stored attempt were written.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReferenceFormat {
    /// Version 2 rows (input-use, typed N/A and Scope roles).
    V2,
    /// Version 1 rows: verified against their digest, then not exposed.
    /// `StoredAttempt.inputs` and `qualifications` stay empty, so claim and
    /// history cannot use them; a history reader excludes such an attempt.
    LegacyV1,
}

/// How an adopted input is used by the request (K4/3 section 5). Native
/// derives it from the input type, role and position; a renderer never
/// supplies it.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputUse {
    /// The current Human message (ordinal 0).
    CurrentTurn,
    /// A requalified past Human message or generated output.
    AdoptedHistory,
    /// Raw, accepted Revision or Graph-derived material chosen by D1.
    SelectedMaterial,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InputReference {
    pub role: InputRole,
    pub target: InputTarget,
    pub input_use: InputUse,
}

/// Wire form of [`InputReference`] (version 2).
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputReferenceWire {
    reference_version: ReferenceVersionV2,
    role: InputRole,
    target: InputTarget,
    input_use: InputUse,
}

impl From<InputReferenceWire> for InputReference {
    fn from(wire: InputReferenceWire) -> Self {
        Self {
            role: wire.role,
            target: wire.target,
            input_use: wire.input_use,
        }
    }
}

impl From<&InputReference> for InputReferenceWire {
    fn from(reference: &InputReference) -> Self {
        Self {
            reference_version: ReferenceVersionV2,
            role: reference.role.clone(),
            target: reference.target.clone(),
            input_use: reference.input_use,
        }
    }
}

impl Serialize for InputReference {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        InputReferenceWire::from(self).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for InputReference {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        InputReferenceWire::deserialize(deserializer).map(Self::from)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum QualificationKind {
    Source,
    Revision,
    Decision,
    Freshness,
    Index,
    Scope,
    D1,
}

const ALL_QUALIFICATION_KINDS: [QualificationKind; 7] = [
    QualificationKind::Source,
    QualificationKind::Revision,
    QualificationKind::Decision,
    QualificationKind::Freshness,
    QualificationKind::Index,
    QualificationKind::Scope,
    QualificationKind::D1,
];

/// Why a qualification kind does not apply to an input (K4/3 section 3).
/// The reasons are the closed set of the typed N/A table.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotApplicableReason {
    NotARevision,
    HumanAuthored,
    DerivedFromParents,
    ManuscriptSource,
    ImmutableMessageVersion,
    TargetSceneBodyNotADependency,
    ExactSourceToken,
    NotIndexDerived,
    FixedUserSlot,
}

/// The role of a present Scope reference (K4/3 sections 2, 3 and 13). Native
/// writes it from the type of the reference; history never infers it from an
/// identity string.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScopeRole {
    ProjectAuthority,
    QuerySceneScope,
    QuerySceneSource,
    QuerySceneIncarnation,
    RevealState,
    ScopeAxis,
    TypedScope,
    MaterialSceneProof,
}

impl ScopeRole {
    /// The roles that occur exactly once for a Revision or Graph-derived input.
    const REVISION_SINGLETONS: [ScopeRole; 6] = [
        ScopeRole::ProjectAuthority,
        ScopeRole::QuerySceneScope,
        ScopeRole::QuerySceneSource,
        ScopeRole::QuerySceneIncarnation,
        ScopeRole::RevealState,
        ScopeRole::ScopeAxis,
    ];
    /// The roles of a Human, generated-output or Raw input.
    const SCENE_ONLY: [ScopeRole; 2] =
        [ScopeRole::QuerySceneScope, ScopeRole::QuerySceneIncarnation];

    /// Roles whose first identity component is the attempt's target Scene.
    fn names_target_scene(self) -> bool {
        matches!(
            self,
            ScopeRole::QuerySceneScope
                | ScopeRole::QuerySceneSource
                | ScopeRole::QuerySceneIncarnation
                | ScopeRole::RevealState
                | ScopeRole::ScopeAxis
        )
    }
}

/// Exact reference/version only, or a typed N/A. Qualification content is
/// never copied here. `input_ordinal` identifies the adopted input whose full
/// qualification this reference belongs to; an accepted Revision is not split
/// into new authorities.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QualificationReference {
    pub input_ordinal: usize,
    pub kind: QualificationKind,
    pub body: QualificationBody,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QualificationBody {
    Present {
        identity: String,
        version: String,
        /// `Some` exactly for a Scope reference.
        scope_role: Option<ScopeRole>,
    },
    NotApplicable {
        reason: NotApplicableReason,
    },
}

impl QualificationReference {
    pub fn present(
        input_ordinal: usize,
        kind: QualificationKind,
        identity: impl Into<String>,
        version: impl Into<String>,
    ) -> Self {
        Self {
            input_ordinal,
            kind,
            body: QualificationBody::Present {
                identity: identity.into(),
                version: version.into(),
                scope_role: None,
            },
        }
    }

    pub fn scope(
        input_ordinal: usize,
        role: ScopeRole,
        identity: impl Into<String>,
        version: impl Into<String>,
    ) -> Self {
        Self {
            input_ordinal,
            kind: QualificationKind::Scope,
            body: QualificationBody::Present {
                identity: identity.into(),
                version: version.into(),
                scope_role: Some(role),
            },
        }
    }

    pub fn not_applicable(
        input_ordinal: usize,
        kind: QualificationKind,
        reason: NotApplicableReason,
    ) -> Self {
        Self {
            input_ordinal,
            kind,
            body: QualificationBody::NotApplicable { reason },
        }
    }

    pub fn identity(&self) -> Option<&str> {
        match &self.body {
            QualificationBody::Present { identity, .. } => Some(identity),
            QualificationBody::NotApplicable { .. } => None,
        }
    }

    pub fn version(&self) -> Option<&str> {
        match &self.body {
            QualificationBody::Present { version, .. } => Some(version),
            QualificationBody::NotApplicable { .. } => None,
        }
    }

    pub fn scope_role(&self) -> Option<ScopeRole> {
        match &self.body {
            QualificationBody::Present { scope_role, .. } => *scope_role,
            QualificationBody::NotApplicable { .. } => None,
        }
    }

    pub fn not_applicable_reason(&self) -> Option<NotApplicableReason> {
        match &self.body {
            QualificationBody::NotApplicable { reason } => Some(*reason),
            QualificationBody::Present { .. } => None,
        }
    }
}

/// Wire form of [`QualificationReference`] (version 2): a present reference
/// or a typed N/A, selected by `state`.
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum QualificationWire {
    Present {
        reference_version: ReferenceVersionV2,
        input_ordinal: usize,
        kind: QualificationKind,
        identity: String,
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope_role: Option<ScopeRole>,
    },
    NotApplicable {
        reference_version: ReferenceVersionV2,
        input_ordinal: usize,
        kind: QualificationKind,
        reason: NotApplicableReason,
    },
}

impl From<QualificationWire> for QualificationReference {
    fn from(wire: QualificationWire) -> Self {
        match wire {
            QualificationWire::Present {
                input_ordinal,
                kind,
                identity,
                version,
                scope_role,
                ..
            } => Self {
                input_ordinal,
                kind,
                body: QualificationBody::Present {
                    identity,
                    version,
                    scope_role,
                },
            },
            QualificationWire::NotApplicable {
                input_ordinal,
                kind,
                reason,
                ..
            } => Self {
                input_ordinal,
                kind,
                body: QualificationBody::NotApplicable { reason },
            },
        }
    }
}

impl From<&QualificationReference> for QualificationWire {
    fn from(reference: &QualificationReference) -> Self {
        match &reference.body {
            QualificationBody::Present {
                identity,
                version,
                scope_role,
            } => Self::Present {
                reference_version: ReferenceVersionV2,
                input_ordinal: reference.input_ordinal,
                kind: reference.kind,
                identity: identity.clone(),
                version: version.clone(),
                scope_role: *scope_role,
            },
            QualificationBody::NotApplicable { reason } => Self::NotApplicable {
                reference_version: ReferenceVersionV2,
                input_ordinal: reference.input_ordinal,
                kind: reference.kind,
                reason: *reason,
            },
        }
    }
}

impl Serialize for QualificationReference {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        QualificationWire::from(self).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for QualificationReference {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        QualificationWire::deserialize(deserializer).map(Self::from)
    }
}

/// Input row format 1: `{role, target}`. Read for the digest check only.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyInputReferenceV1 {
    role: InputRole,
    target: InputTarget,
}

/// Qualification row format 1: `{inputOrdinal, kind, identity, version}`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyQualificationReferenceV1 {
    input_ordinal: usize,
    kind: QualificationKind,
    identity: String,
    version: String,
}

/// Reads only `referenceVersion`. Other keys are skipped, and a duplicated
/// `referenceVersion` key is a parse error.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceVersionProbe {
    #[serde(default)]
    reference_version: Option<Value>,
}

enum VersionedReference<C, L> {
    Legacy(L),
    Current(C),
}

/// The single parser of a stored reference row. An explicit `referenceVersion`
/// selects the struct before the whole value is parsed, and every struct
/// denies unknown fields. A later version adds an arm here; until then it is
/// rejected. A row without the key is format 1.
fn parse_versioned_reference<C, L>(raw: &str) -> Result<VersionedReference<C, L>>
where
    C: serde::de::DeserializeOwned,
    L: serde::de::DeserializeOwned,
{
    let probe: ReferenceVersionProbe =
        serde_json::from_str(raw).context(REFERENCE_INVALID_ERROR)?;
    match probe.reference_version {
        None => Ok(VersionedReference::Legacy(
            serde_json::from_str(raw).context(REFERENCE_INVALID_ERROR)?,
        )),
        Some(Value::Number(version)) if version.as_u64() == Some(REFERENCE_VERSION) => {
            Ok(VersionedReference::Current(
                serde_json::from_str(raw).context(REFERENCE_INVALID_ERROR)?,
            ))
        }
        Some(_) => anyhow::bail!(REFERENCE_VERSION_UNSUPPORTED_ERROR),
    }
}

type StoredInputRow = VersionedReference<InputReference, LegacyInputReferenceV1>;
type StoredQualificationRow =
    VersionedReference<QualificationReference, LegacyQualificationReferenceV1>;

/// The reference rows of one stored attempt after the version dispatch.
struct VersionedReferences {
    format: ReferenceFormat,
    inputs: Vec<InputReference>,
    qualifications: Vec<QualificationReference>,
    /// The digest this attempt's rows must reproduce.
    computed_digest: String,
}

/// Dispatch both reference lists. All rows of an attempt must share one
/// format. An attempt without any rows is judged by its stored digest domain.
fn read_versioned_references(
    inputs: Vec<StoredInputRow>,
    qualifications: Vec<StoredQualificationRow>,
    stored_digest: &str,
) -> Result<VersionedReferences> {
    let mut current_inputs = Vec::new();
    let mut legacy_inputs = Vec::new();
    for row in inputs {
        match row {
            VersionedReference::Current(row) => current_inputs.push(row),
            VersionedReference::Legacy(row) => legacy_inputs.push(row),
        }
    }
    let mut current_qualifications = Vec::new();
    let mut legacy_qualifications = Vec::new();
    for row in qualifications {
        match row {
            VersionedReference::Current(row) => current_qualifications.push(row),
            VersionedReference::Legacy(row) => legacy_qualifications.push(row),
        }
    }
    let has_current = !current_inputs.is_empty() || !current_qualifications.is_empty();
    let has_legacy = !legacy_inputs.is_empty() || !legacy_qualifications.is_empty();
    ensure!(
        !(has_current && has_legacy),
        "{}",
        REFERENCE_FORMAT_MIXED_ERROR
    );
    let current_digest = input_digest(&current_inputs, &current_qualifications)?;
    let legacy_digest = legacy_input_digest(&legacy_inputs, &legacy_qualifications)?;
    let legacy = if has_legacy {
        true
    } else if has_current {
        false
    } else {
        // No rows at all: the stored digest names the domain it was made with.
        current_digest != stored_digest && legacy_digest == stored_digest
    };
    if legacy {
        Ok(VersionedReferences {
            format: ReferenceFormat::LegacyV1,
            inputs: Vec::new(),
            qualifications: Vec::new(),
            computed_digest: legacy_digest,
        })
    } else {
        Ok(VersionedReferences {
            format: ReferenceFormat::V2,
            inputs: current_inputs,
            qualifications: current_qualifications,
            computed_digest: current_digest,
        })
    }
}

// ---------------------------------------------------------------------------
// Typed targets, the typed N/A table and the completeness rule (K4/3 section 3)
// ---------------------------------------------------------------------------

/// Escape one identity component so that `:` joins components without any
/// collision. Only `%` and `:` change, so a UUID is unchanged.
pub fn escape_identity_component(component: &str) -> String {
    component.replace('%', "%25").replace(':', "%3A")
}

fn unescape_identity_component(component: &str) -> Option<String> {
    if component.is_empty() {
        return None;
    }
    let bytes = component.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                match bytes.get(index + 1..index + 3)? {
                    b"25" => out.push(b'%'),
                    b"3A" => out.push(b':'),
                    _ => return None,
                }
                index += 3;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Build the identity of a present Scope reference from its role and typed
/// components (K4/3 section 13). The component count is fixed per role: two
/// for `typed-scope` (revision ID, index) and `material-scene-proof`
/// (anchor Scene ID, incarnation), otherwise one.
pub fn scope_identity(role: ScopeRole, components: &[&str]) -> Result<String> {
    let escaped: Vec<String> = components
        .iter()
        .map(|component| escape_identity_component(component))
        .collect();
    let identity = match (role, escaped.as_slice()) {
        (ScopeRole::ProjectAuthority, [a]) => format!("project:scope-authority:{a}"),
        (ScopeRole::QuerySceneScope, [a]) => format!("scene:{a}"),
        (ScopeRole::QuerySceneSource, [a]) => format!("scene-source:{a}"),
        (ScopeRole::QuerySceneIncarnation, [a]) => format!("scene-incarnation:{a}"),
        (ScopeRole::RevealState, [a]) => format!("reveal-state:{a}"),
        (ScopeRole::ScopeAxis, [a]) => format!("scope-axis:{a}"),
        (ScopeRole::TypedScope, [a, b]) => format!("revision:{a}:typed-scope:{b}"),
        (ScopeRole::MaterialSceneProof, [a, b]) => format!("scene:{a}:{b}"),
        _ => anyhow::bail!("NIR1_GENERATION_SCOPE_IDENTITY_ARITY"),
    };
    Ok(identity)
}

/// The typed components of a Scope identity built by [`scope_identity`], or
/// `None` when the identity does not follow the role's grammar.
pub fn parse_scope_identity(role: ScopeRole, identity: &str) -> Option<Vec<String>> {
    let segments: Vec<&str> = identity.split(':').collect();
    let components: Vec<&str> = match (role, segments.as_slice()) {
        (ScopeRole::ProjectAuthority, ["project", "scope-authority", a]) => vec![a],
        (ScopeRole::QuerySceneScope, ["scene", a]) => vec![a],
        (ScopeRole::QuerySceneSource, ["scene-source", a]) => vec![a],
        (ScopeRole::QuerySceneIncarnation, ["scene-incarnation", a]) => vec![a],
        (ScopeRole::RevealState, ["reveal-state", a]) => vec![a],
        (ScopeRole::ScopeAxis, ["scope-axis", a]) => vec![a],
        (ScopeRole::TypedScope, ["revision", a, "typed-scope", b]) => vec![a, b],
        (ScopeRole::MaterialSceneProof, ["scene", a, b]) => vec![a, b],
        _ => return None,
    };
    components
        .into_iter()
        .map(unescape_identity_component)
        .collect()
}

/// The `(kind, target)` of a present reference as a typed tuple. Two
/// references are the same target when their tuples are equal, whatever their
/// versions are; the comparison never looks at a joined identity string.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TypedTarget {
    pub kind: QualificationKind,
    pub scope_role: Option<ScopeRole>,
    pub components: Vec<String>,
}

/// The typed target of a present reference, `Ok(None)` for a typed N/A, and
/// `Err(MalformedTarget)` when a Scope identity does not follow its role.
pub fn typed_target(
    reference: &QualificationReference,
) -> std::result::Result<Option<TypedTarget>, CompletenessReason> {
    let QualificationBody::Present {
        identity,
        scope_role,
        ..
    } = &reference.body
    else {
        return Ok(None);
    };
    if identity.is_empty() {
        return Err(CompletenessReason::MalformedTarget);
    }
    let components = match (reference.kind, scope_role) {
        (QualificationKind::Scope, Some(role)) => {
            parse_scope_identity(*role, identity).ok_or(CompletenessReason::MalformedTarget)?
        }
        (QualificationKind::Scope, None) => return Err(CompletenessReason::ScopeRoleInvalid),
        (_, Some(_)) => return Err(CompletenessReason::ScopeRoleInvalid),
        (_, None) => vec![identity.clone()],
    };
    Ok(Some(TypedTarget {
        kind: reference.kind,
        scope_role: *scope_role,
        components,
    }))
}

/// How a recorded reference is compared on every later turn (K4/3 section 13).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReferenceClass {
    /// Compared exactly: Source, Revision, Decision, Index and typed scope.
    Dependency,
    /// Recorded, not compared; re-judged by the current evaluation.
    RequestContext,
    /// Compared as part of the turn's own context (scene, incarnation, axis).
    TurnContext,
    /// The D1 selection, recomputed from the stored rows.
    D1Selection,
}

/// Classify a present reference by its kind and Scope role only. A Scope
/// reference without a role has no class.
pub fn classify_reference(
    kind: QualificationKind,
    scope_role: Option<ScopeRole>,
) -> Option<ReferenceClass> {
    match kind {
        QualificationKind::Source
        | QualificationKind::Revision
        | QualificationKind::Decision
        | QualificationKind::Index => Some(ReferenceClass::Dependency),
        QualificationKind::Freshness => Some(ReferenceClass::RequestContext),
        QualificationKind::D1 => Some(ReferenceClass::D1Selection),
        QualificationKind::Scope => match scope_role? {
            ScopeRole::TypedScope => Some(ReferenceClass::Dependency),
            ScopeRole::ProjectAuthority
            | ScopeRole::RevealState
            | ScopeRole::QuerySceneSource
            | ScopeRole::MaterialSceneProof => Some(ReferenceClass::RequestContext),
            ScopeRole::QuerySceneScope
            | ScopeRole::QuerySceneIncarnation
            | ScopeRole::ScopeAxis => Some(ReferenceClass::TurnContext),
        },
    }
}

/// The row of the typed N/A table that an input falls in.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InputClass {
    CurrentHuman,
    HistoryHuman,
    GeneratedOutput,
    RawSource,
    AcceptedRevision,
    GraphEvidence,
    Artifact,
}

fn input_class(input: &InputReference) -> Option<InputClass> {
    match (&input.target, &input.role, input.input_use) {
        (InputTarget::Message { .. }, InputRole::User, InputUse::CurrentTurn) => {
            Some(InputClass::CurrentHuman)
        }
        (InputTarget::Message { .. }, InputRole::User, InputUse::AdoptedHistory) => {
            Some(InputClass::HistoryHuman)
        }
        (InputTarget::Message { .. }, InputRole::Assistant, InputUse::AdoptedHistory) => {
            Some(InputClass::GeneratedOutput)
        }
        (InputTarget::RawSource { .. }, InputRole::Context, InputUse::SelectedMaterial) => {
            Some(InputClass::RawSource)
        }
        (InputTarget::AcceptedRevision { .. }, InputRole::Context, InputUse::SelectedMaterial) => {
            Some(InputClass::AcceptedRevision)
        }
        (InputTarget::GraphEvidence { .. }, InputRole::Context, InputUse::SelectedMaterial) => {
            Some(InputClass::GraphEvidence)
        }
        (
            InputTarget::Artifact { .. },
            _,
            InputUse::AdoptedHistory | InputUse::SelectedMaterial,
        ) => Some(InputClass::Artifact),
        _ => None,
    }
}

/// One cell of the K4/3 section 3 table.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TableCell {
    /// At least one present reference.
    Required,
    /// A typed N/A with one of these reasons.
    NotApplicable(&'static [NotApplicableReason]),
    /// The input type is unsupported: no kind is evaluated.
    Unsupported,
}

const NA_NOT_A_REVISION: &[NotApplicableReason] = &[NotApplicableReason::NotARevision];
const NA_HUMAN_AUTHORED: &[NotApplicableReason] = &[NotApplicableReason::HumanAuthored];
const NA_DERIVED_FROM_PARENTS: &[NotApplicableReason] = &[NotApplicableReason::DerivedFromParents];
const NA_MANUSCRIPT_SOURCE: &[NotApplicableReason] = &[NotApplicableReason::ManuscriptSource];
const NA_IMMUTABLE_MESSAGE: &[NotApplicableReason] =
    &[NotApplicableReason::ImmutableMessageVersion];
const NA_RAW_FRESHNESS: &[NotApplicableReason] = &[
    NotApplicableReason::TargetSceneBodyNotADependency,
    NotApplicableReason::ExactSourceToken,
];
const NA_NOT_INDEX_DERIVED: &[NotApplicableReason] = &[NotApplicableReason::NotIndexDerived];
const NA_FIXED_USER_SLOT: &[NotApplicableReason] = &[NotApplicableReason::FixedUserSlot];

fn table_cell(class: InputClass, kind: QualificationKind) -> TableCell {
    use QualificationKind as K;
    use TableCell::{NotApplicable as Na, Required};
    match class {
        InputClass::CurrentHuman | InputClass::HistoryHuman | InputClass::GeneratedOutput => {
            match kind {
                K::Source | K::Scope => Required,
                K::Revision => Na(NA_NOT_A_REVISION),
                K::Decision if class == InputClass::GeneratedOutput => Na(NA_DERIVED_FROM_PARENTS),
                K::Decision => Na(NA_HUMAN_AUTHORED),
                K::Freshness => Na(NA_IMMUTABLE_MESSAGE),
                K::Index => Na(NA_NOT_INDEX_DERIVED),
                K::D1 if class == InputClass::CurrentHuman => Na(NA_FIXED_USER_SLOT),
                K::D1 => Required,
            }
        }
        InputClass::RawSource => match kind {
            K::Source | K::Scope | K::D1 => Required,
            K::Revision => Na(NA_NOT_A_REVISION),
            K::Decision => Na(NA_MANUSCRIPT_SOURCE),
            K::Freshness => Na(NA_RAW_FRESHNESS),
            K::Index => Na(NA_NOT_INDEX_DERIVED),
        },
        InputClass::AcceptedRevision => match kind {
            K::Index => Na(NA_NOT_INDEX_DERIVED),
            _ => Required,
        },
        // Graph-derived input needs an Index reference. Its form is Pending,
        // so no N/A is allowed for any kind.
        InputClass::GraphEvidence => Required,
        InputClass::Artifact => TableCell::Unsupported,
    }
}

/// Why an attempt's references do not satisfy the completeness rule.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletenessReason {
    /// A qualification row names an input that does not exist.
    QualificationInputMissing,
    /// The input-use does not fit the input's role and type.
    InputUseMismatch,
    /// The input type (Artifact) is unsupported.
    UnsupportedInput,
    /// Neither a reference nor a typed N/A for this kind.
    MissingKind,
    /// A reference and a typed N/A for the same kind.
    ReferenceAndNotApplicable,
    /// Two typed N/A rows for the same kind.
    DuplicateNotApplicable,
    /// A typed N/A in a cell that requires a reference, or with a reason the
    /// table does not allow.
    NotApplicableNotInTable,
    /// The Raw Freshness reason does not follow the source key.
    NotApplicableReasonMismatch,
    /// A reference in a cell the table fills with a typed N/A.
    ReferenceNotInTable,
    /// Two references with the same `(kind, target)`.
    DuplicateTarget,
    /// An empty identity, a Scope identity that does not follow its role, or a
    /// D1 identity that is not the selection identity.
    MalformedTarget,
    /// A Scope role on a non-Scope kind, or a Scope reference without a role.
    ScopeRoleInvalid,
    /// A Scope role the input type does not carry.
    ScopeRoleNotAllowed,
    /// A required Scope role is absent.
    ScopeRoleMissing,
    /// A singleton Scope role occurs more than once.
    ScopeRoleDuplicated,
    /// A query-Scene role names a Scene other than the attempt's target.
    ScopeSceneMismatch,
    /// A target of the expected set is absent.
    ExpectedTargetMissing,
    /// A target outside the expected set.
    UnexpectedTarget,
}

/// The first violation of the completeness rule, with the input and kind it
/// concerns.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompletenessViolation {
    pub input_ordinal: Option<usize>,
    pub kind: Option<QualificationKind>,
    pub scope_role: Option<ScopeRole>,
    pub reason: CompletenessReason,
}

impl fmt::Display for CompletenessViolation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "NIR1_GENERATION_QUALIFICATION_INCOMPLETE: {:?} (input {:?}, kind {:?}, role {:?})",
            self.reason, self.input_ordinal, self.kind, self.scope_role
        )
    }
}

impl std::error::Error for CompletenessViolation {}

/// What the completeness rule needs beyond the stored rows.
#[derive(Clone, Copy, Debug)]
pub struct CompletenessContext<'a> {
    /// The attempt's target Scene (`AttemptBinding.scene.scene_id`).
    pub target_scene_id: &'a str,
    /// Rule 3: the targets that the current state derives for an input, by
    /// ordinal. When an input has an entry, its present targets must equal it
    /// exactly; an input without an entry is checked structurally only.
    pub expected_targets: Option<&'a BTreeMap<usize, std::collections::BTreeSet<TypedTarget>>>,
}

fn violation(
    input_ordinal: usize,
    kind: Option<QualificationKind>,
    scope_role: Option<ScopeRole>,
    reason: CompletenessReason,
) -> CompletenessViolation {
    CompletenessViolation {
        input_ordinal: Some(input_ordinal),
        kind,
        scope_role,
        reason,
    }
}

/// The completeness rule of K4/3 section 3, a pure function shared by the
/// D-final finalizer and the history checker. For every input, each of the 7
/// kinds has one or more references or the typed N/A of the table, never
/// both; no `(kind, target)` repeats; an N/A outside the table and a
/// reference where the table puts an N/A are incomplete; an Artifact input is
/// unsupported. Scope references need their closed roles. The writer stores an
/// incomplete attempt (DR-DFP-4) but replaces its history context with
/// `d-final-incomplete`, so it is never used as history.
pub fn check_attempt_completeness(
    inputs: &[InputReference],
    qualifications: &[QualificationReference],
    context: &CompletenessContext<'_>,
) -> std::result::Result<(), CompletenessViolation> {
    // K4/3 section 5: the current turn is exactly one User message at
    // ordinal 0. A second current-turn input, or one past ordinal 0, would let
    // the D1 selection digest (which skips current-turn inputs) start from the
    // wrong input.
    // A conversation attempt (one that carries a Message input) must start
    // with that current turn; a material-only input set has no current turn.
    let conversation = inputs
        .iter()
        .any(|input| matches!(input.target, InputTarget::Message { .. }));
    for (ordinal, input) in inputs.iter().enumerate() {
        let is_current = input.input_use == InputUse::CurrentTurn;
        let expected_current = conversation && ordinal == 0;
        if is_current != expected_current && (is_current || conversation) {
            return Err(violation(
                ordinal,
                None,
                None,
                CompletenessReason::InputUseMismatch,
            ));
        }
    }
    let mut by_input: Vec<Vec<&QualificationReference>> = vec![Vec::new(); inputs.len()];
    for reference in qualifications {
        match by_input.get_mut(reference.input_ordinal) {
            Some(slot) => slot.push(reference),
            None => {
                return Err(violation(
                    reference.input_ordinal,
                    Some(reference.kind),
                    reference.scope_role(),
                    CompletenessReason::QualificationInputMissing,
                ))
            }
        }
    }
    for (ordinal, (input, references)) in inputs.iter().zip(&by_input).enumerate() {
        check_input_completeness(ordinal, input, references, context)?;
    }
    Ok(())
}

/// The completeness rule of K4/3 section 3 for one input and its references
/// (`references` are the rows of that input only). [`check_attempt_completeness`]
/// runs it for every input; the history checker, which sees one adopted input
/// at a time, calls it directly so that both share one rule.
pub fn check_input_completeness(
    ordinal: usize,
    input: &InputReference,
    references: &[&QualificationReference],
    context: &CompletenessContext<'_>,
) -> std::result::Result<(), CompletenessViolation> {
    let class = input_class(input)
        .ok_or_else(|| violation(ordinal, None, None, CompletenessReason::InputUseMismatch))?;
    if class == InputClass::Artifact {
        return Err(violation(
            ordinal,
            None,
            None,
            CompletenessReason::UnsupportedInput,
        ));
    }
    let raw_freshness_reason = match &input.target {
        InputTarget::RawSource { source_key, .. }
            if *source_key == format!("project:scene:{}", context.target_scene_id) =>
        {
            NotApplicableReason::TargetSceneBodyNotADependency
        }
        _ => NotApplicableReason::ExactSourceToken,
    };
    let mut targets = std::collections::BTreeSet::new();
    let mut scope_roles = BTreeMap::<ScopeRole, usize>::new();
    for kind in ALL_QUALIFICATION_KINDS {
        let mut present = Vec::new();
        let mut not_applicable = Vec::new();
        for reference in references.iter().filter(|reference| reference.kind == kind) {
            match &reference.body {
                QualificationBody::Present { .. } => present.push(*reference),
                QualificationBody::NotApplicable { reason } => not_applicable.push(*reason),
            }
        }
        let fail = |reason| Err(violation(ordinal, Some(kind), None, reason));
        if !present.is_empty() && !not_applicable.is_empty() {
            return fail(CompletenessReason::ReferenceAndNotApplicable);
        }
        if not_applicable.len() > 1 {
            return fail(CompletenessReason::DuplicateNotApplicable);
        }
        match table_cell(class, kind) {
            TableCell::Unsupported => {
                return fail(CompletenessReason::UnsupportedInput);
            }
            TableCell::Required => {
                if !not_applicable.is_empty() {
                    return fail(CompletenessReason::NotApplicableNotInTable);
                }
                if present.is_empty() {
                    return fail(CompletenessReason::MissingKind);
                }
            }
            TableCell::NotApplicable(allowed) => {
                if !present.is_empty() {
                    return fail(CompletenessReason::ReferenceNotInTable);
                }
                let Some(reason) = not_applicable.first() else {
                    return fail(CompletenessReason::MissingKind);
                };
                if !allowed.contains(reason) {
                    return fail(CompletenessReason::NotApplicableNotInTable);
                }
                if class == InputClass::RawSource
                    && kind == QualificationKind::Freshness
                    && *reason != raw_freshness_reason
                {
                    return fail(CompletenessReason::NotApplicableReasonMismatch);
                }
            }
        }
        for reference in present {
            let role = reference.scope_role();
            let target = typed_target(reference)
                .map_err(|reason| violation(ordinal, Some(kind), role, reason))?;
            let Some(target) = target else { continue };
            if kind == QualificationKind::D1 && reference.identity() != Some(D1_SELECTION_IDENTITY)
            {
                return Err(violation(
                    ordinal,
                    Some(kind),
                    role,
                    CompletenessReason::MalformedTarget,
                ));
            }
            if let Some(role) = role {
                let allowed = match class {
                    InputClass::AcceptedRevision | InputClass::GraphEvidence => true,
                    _ => ScopeRole::SCENE_ONLY.contains(&role),
                };
                if !allowed {
                    return Err(violation(
                        ordinal,
                        Some(kind),
                        Some(role),
                        CompletenessReason::ScopeRoleNotAllowed,
                    ));
                }
                if role.names_target_scene()
                    && target.components.first().map(String::as_str)
                        != Some(context.target_scene_id)
                {
                    return Err(violation(
                        ordinal,
                        Some(kind),
                        Some(role),
                        CompletenessReason::ScopeSceneMismatch,
                    ));
                }
                *scope_roles.entry(role).or_default() += 1;
            }
            if !targets.insert(target) {
                return Err(violation(
                    ordinal,
                    Some(kind),
                    role,
                    CompletenessReason::DuplicateTarget,
                ));
            }
        }
    }
    let required_roles: &[ScopeRole] = match class {
        InputClass::AcceptedRevision | InputClass::GraphEvidence => &ScopeRole::REVISION_SINGLETONS,
        _ => &ScopeRole::SCENE_ONLY,
    };
    for role in required_roles {
        match scope_roles.get(role).copied().unwrap_or(0) {
            0 => {
                return Err(violation(
                    ordinal,
                    Some(QualificationKind::Scope),
                    Some(*role),
                    CompletenessReason::ScopeRoleMissing,
                ))
            }
            1 => {}
            _ => {
                return Err(violation(
                    ordinal,
                    Some(QualificationKind::Scope),
                    Some(*role),
                    CompletenessReason::ScopeRoleDuplicated,
                ))
            }
        }
    }
    if let Some(expected) = context
        .expected_targets
        .and_then(|expected| expected.get(&ordinal))
    {
        if let Some(missing) = expected.difference(&targets).next() {
            return Err(violation(
                ordinal,
                Some(missing.kind),
                missing.scope_role,
                CompletenessReason::ExpectedTargetMissing,
            ));
        }
        if let Some(extra) = targets.difference(expected).next() {
            return Err(violation(
                ordinal,
                Some(extra.kind),
                extra.scope_role,
                CompletenessReason::UnexpectedTarget,
            ));
        }
    }
    Ok(())
}

/// The shape check of the writer: only rows that fall outside the closed
/// types are refused (an input-use that does not fit the input, a typed N/A
/// that is not in the table, a Scope role on a non-Scope kind or a Scope
/// reference without one). The completeness rule itself is not enforced here.
fn validate_reference_shapes(
    inputs: &[InputReference],
    qualifications: &[QualificationReference],
) -> Result<()> {
    let mut classes = Vec::with_capacity(inputs.len());
    for input in inputs {
        classes.push(input_class(input).context("NIR1_GENERATION_INPUT_USE_MISMATCH")?);
    }
    for reference in qualifications {
        let class = *classes
            .get(reference.input_ordinal)
            .context("NIR1_GENERATION_QUALIFICATION_INPUT_MISSING")?;
        match &reference.body {
            QualificationBody::NotApplicable { reason } => {
                let TableCell::NotApplicable(allowed) = table_cell(class, reference.kind) else {
                    anyhow::bail!("NIR1_GENERATION_NOT_APPLICABLE_NOT_IN_TABLE");
                };
                ensure!(
                    allowed.contains(reason),
                    "NIR1_GENERATION_NOT_APPLICABLE_NOT_IN_TABLE"
                );
            }
            QualificationBody::Present { scope_role, .. } => {
                ensure!(
                    scope_role.is_some() == (reference.kind == QualificationKind::Scope),
                    "NIR1_GENERATION_SCOPE_ROLE_MISMATCH"
                );
            }
        }
    }
    Ok(())
}

/// The parameters of one D1 selection (K4/3 section 2): the estimator, the
/// selector budget, and the usage that is known after rendering.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct D1SelectionParameters {
    pub estimator_version: String,
    pub selector_budget_tokens: u64,
    pub used_tokens: u64,
    pub remaining_tokens: u64,
}

/// The D1 selection digest. It covers the estimator version, the selector
/// budget, the usage and remainder, and the adopted inputs in order (ordinal,
/// input-use, target), so it is recomputed from the stored input rows and the
/// context's d1 fields alone. The current Human has a fixed slot and is not
/// part of the selection.
pub fn d1_selection_digest(
    parameters: &D1SelectionParameters,
    inputs: &[InputReference],
) -> Result<String> {
    ensure!(
        !parameters.estimator_version.is_empty()
            && parameters.estimator_version.len() <= MAX_SHORT_TEXT_BYTES
            && parameters
                .used_tokens
                .checked_add(parameters.remaining_tokens)
                == Some(parameters.selector_budget_tokens),
        "NIR1_GENERATION_D1_SELECTION_INVALID"
    );
    let adopted: Vec<Value> = inputs
        .iter()
        .enumerate()
        .filter(|(_, input)| input.input_use != InputUse::CurrentTurn)
        .map(|(ordinal, input)| {
            Ok(json!({
                "ordinal": ordinal,
                "inputUse": input.input_use,
                "target": input.target,
            }))
        })
        .collect::<Result<_>>()?;
    Ok(canonical_json_digest(&json!({
        "domain": D1_SELECTION_DIGEST_DOMAIN,
        "estimatorVersion": parameters.estimator_version,
        "selectorBudgetTokens": parameters.selector_budget_tokens,
        "usedTokens": parameters.used_tokens,
        "remainingTokens": parameters.remaining_tokens,
        "inputs": adopted,
    }))?)
}

/// The D1 qualification reference of an adopted input.
pub fn d1_selection_reference(
    input_ordinal: usize,
    selection_digest: &str,
) -> QualificationReference {
    QualificationReference::present(
        input_ordinal,
        QualificationKind::D1,
        D1_SELECTION_IDENTITY,
        selection_digest,
    )
}

/// Limits are selected by the owning turn. This storage layer does not invent
/// product history capacity numbers or reset a budget separately per ancestor.
#[derive(Clone, Copy, Debug)]
pub struct ReadBudget {
    pub max_references: usize,
    pub max_reference_bytes: usize,
}

/// Caller-owned limits for one history snapshot read. The history owner is
/// responsible for choosing these values and sharing them across its whole
/// turn; this reader never resets them per ancestor or candidate.
#[derive(Debug)]
pub(crate) struct GenerationHistoryReadBudget {
    pub max_attempts: usize,
    /// Caller-owned whole-turn SQLite VM-step, deadline, and busy-wait
    /// ledger. `None` rejects every snapshot before SQL; storage has no
    /// history SQL default.
    pub sql: Option<GenerationHistorySqlLedger>,
    /// Caller-owned upper bound for one candidate page. The storage reader
    /// never chooses a product default; the adapter checks this before it
    /// opens a transaction or allocates traversal results.
    pub max_candidates: usize,
    pub max_reference_count: usize,
    pub max_reference_bytes: usize,
    pub max_resolved_body_bytes: usize,
    /// Caller-owned whole-turn project-authority row allowance. Debit once
    /// per tree, Scene-binding, and registry row; zero fails closed.
    pub remaining_project_authority_rows: usize,
    /// Caller-owned whole-turn traversal limits. These counters are shared
    /// with the pure history walk; they are deliberately not defaults owned
    /// by storage and are never reset for a candidate or ancestor.
    pub remaining_nodes: usize,
    pub remaining_edges: usize,
    pub remaining_qualification_refs: usize,
}

/// Caller-selected SQL limits for one history turn. The numbers are measured
/// by the owner; this storage layer never supplies defaults.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct GenerationHistorySnapshotSqlBudget {
    pub max_vm_steps: u64,
    pub deadline: Instant,
    /// Upper bound for one SQLite busy wait; it is further clipped to the
    /// remaining deadline. Zero refuses to wait.
    pub busy_wait: Duration,
}

/// One turn's SQL counter. The VM-step counter is created with the ledger and
/// shared by every snapshot call that receives it, so separate direct calls
/// never replenish the caller's allowance.
#[derive(Debug)]
pub(crate) struct GenerationHistorySqlLedger {
    limits: GenerationHistorySnapshotSqlBudget,
    capacity: Arc<CapacityBudget>,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the turn owner that measures and supplies history SQL limits is not wired yet"
    )
)]
impl GenerationHistorySqlLedger {
    pub(crate) fn new(limits: GenerationHistorySnapshotSqlBudget) -> Self {
        Self {
            limits,
            capacity: CapacityBudget::new(limits.max_vm_steps, limits.deadline),
        }
    }

    pub(crate) fn sql_steps_used(&self) -> u64 {
        self.capacity.sql_steps_used()
    }
}

/// The SQL limits admitted for one snapshot call, checked before any SQL.
struct AdmittedHistorySql {
    capacity: Arc<CapacityBudget>,
    deadline: Instant,
    busy_wait: Duration,
}

impl GenerationHistoryReadBudget {
    fn admit_sql(
        &self,
        cancellation: &GenerationHistorySnapshotCancellation,
    ) -> Result<AdmittedHistorySql> {
        cancellation.checkpoint()?;
        let ledger = self
            .sql
            .as_ref()
            .context("NIR1_GENERATION_HISTORY_SQL_BUDGET_MISSING")?;
        ensure!(
            ledger.limits.max_vm_steps > 0,
            "NIR1_GENERATION_HISTORY_SQL_BUDGET_INVALID"
        );
        // Any SQL statement costs at least one VM step, so a fully used
        // turn ledger is refused here instead of by an interrupt.
        if ledger.capacity.sql_steps_used() >= ledger.limits.max_vm_steps {
            return Err(validation_terminated(
                ValidationTerminationReason::CapacityExceeded,
                "generation history SQL budget exhausted",
            ));
        }
        let deadline = cancellation
            .deadline
            .map_or(ledger.limits.deadline, |owner| {
                owner.min(ledger.limits.deadline)
            });
        if Instant::now() >= deadline {
            return Err(validation_terminated(
                ValidationTerminationReason::TimedOut,
                "generation history SQL deadline elapsed",
            ));
        }
        Ok(AdmittedHistorySql {
            capacity: Arc::clone(&ledger.capacity),
            deadline,
            busy_wait: ledger.limits.busy_wait,
        })
    }

    /// Debit one caller-owned whole-turn project-authority row.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "bounded project authority stays unwired until K4 decides its scope"
        )
    )]
    pub(crate) fn consume_project_authority_row(&mut self) -> Result<()> {
        ensure!(
            self.remaining_project_authority_rows > 0,
            "NIR1_GENERATION_HISTORY_PROJECT_AUTHORITY_ROW_LIMIT"
        );
        self.remaining_project_authority_rows -= 1;
        Ok(())
    }

    fn child_reference_budget(&self) -> ReadBudget {
        ReadBudget {
            max_references: self.max_reference_count,
            max_reference_bytes: self.max_reference_bytes,
        }
    }

    fn apply_child_reference_budget(&mut self, budget: ReadBudget) {
        self.max_reference_count = budget.max_references;
        self.max_reference_bytes = budget.max_reference_bytes;
    }

    fn consume_attempt(&mut self) -> Result<()> {
        ensure!(self.max_attempts > 0, "NIR1_GENERATION_HISTORY_LIMIT");
        self.max_attempts -= 1;
        Ok(())
    }

    /// Debit `count` attempt rows at once from the same whole-turn ledger.
    fn consume_attempts(&mut self, count: usize) -> Result<()> {
        ensure!(self.max_attempts >= count, "NIR1_GENERATION_HISTORY_LIMIT");
        self.max_attempts -= count;
        Ok(())
    }

    fn reserve_body_bytes(&mut self, bytes: usize) -> Result<()> {
        ensure!(
            bytes <= self.max_resolved_body_bytes,
            "NIR1_GENERATION_HISTORY_BODY_LIMIT"
        );
        self.max_resolved_body_bytes -= bytes;
        Ok(())
    }

    /// Debit one whole-turn history node. The history adapter maps this
    /// storage error to its typed `BudgetExhausted` result.
    pub(crate) fn consume_node(&mut self) -> Result<()> {
        ensure!(
            self.remaining_nodes > 0,
            "NIR1_GENERATION_HISTORY_BUDGET_EXHAUSTED"
        );
        self.remaining_nodes -= 1;
        Ok(())
    }

    /// Debit one whole-turn history edge.
    pub(crate) fn consume_edge(&mut self) -> Result<()> {
        ensure!(
            self.remaining_edges > 0,
            "NIR1_GENERATION_HISTORY_BUDGET_EXHAUSTED"
        );
        self.remaining_edges -= 1;
        Ok(())
    }

    /// Debit qualification references from the same whole-turn ledger as
    /// node and edge visits.
    pub(crate) fn consume_qualification_refs(&mut self, count: usize) -> Result<()> {
        ensure!(
            self.remaining_qualification_refs >= count,
            "NIR1_GENERATION_HISTORY_BUDGET_EXHAUSTED"
        );
        self.remaining_qualification_refs -= count;
        Ok(())
    }
}

/// A message version plus the immutable chat row it authenticates. The body
/// is returned only as owned values after scalar length admission. There is no
/// borrowed connection or JSON value in this type.
#[derive(Clone, Debug)]
#[expect(
    dead_code,
    reason = "snapshot body/metadata remain internal until history authority and disclosure wiring is approved"
)]
pub(crate) struct GenerationHistoryMessage {
    pub version: MessageVersion,
    pub chat_role: String,
    pub content: String,
    pub metadata: Option<Value>,
    pub created_at: String,
}

/// Artifact identity is readable from the existing artifact store, but the
/// schema has no NIR generation producer receipt link. Those fields therefore
/// remain absent and history qualification must fail closed for artifact
/// lineage until a confirmed immutable extension supplies them.
#[derive(Clone, Debug)]
pub(crate) struct GenerationHistoryArtifact {
    pub artifact_id: String,
    #[expect(
        dead_code,
        reason = "artifact history lineage qualification remains HOLD"
    )]
    pub project_id: String,
    pub payload_digest: String,
    pub producer_attempt_id: Option<String>,
    pub producer_receipt_digest: Option<String>,
}

#[derive(Clone, Debug)]
pub struct NewAttempt {
    pub binding: AttemptBinding,
    pub payload_digest: String,
    pub inputs: Vec<InputReference>,
    pub qualifications: Vec<QualificationReference>,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub budget: ReadBudget,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredAttempt {
    pub id: String,
    pub binding: AttemptBinding,
    pub payload_digest: String,
    pub input_digest: String,
    /// Empty when `reference_format` is `LegacyV1`: such rows are verified
    /// against their digest and then not exposed.
    pub inputs: Vec<InputReference>,
    pub qualifications: Vec<QualificationReference>,
    pub reference_format: ReferenceFormat,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub claimed_at_ms: Option<i64>,
    pub terminal: Option<StoredTerminal>,
}

impl StoredAttempt {
    /// Why a history reader does not use this attempt, from its history slot
    /// alone. The snapshot reader returns such an attempt without reading
    /// any reference row (`inputs` and `qualifications` are empty).
    pub(crate) fn history_gate(&self) -> Option<HistoryContextGateReason> {
        history_gate_reason(&self.binding)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MessageOrigin {
    Human,
    Generated,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageVersion {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub message_id: String,
    pub origin: MessageOrigin,
    pub body_digest: String,
    pub parent_attempt_id: Option<String>,
    pub created_at_ms: i64,
}

/// Main-issued caller and exact Native workspace incarnation for one current
/// Human capture. `caller_session_id` is deliberately not the chat session ID.
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatInputCaptureOwner {
    profile_id: String,
    caller_id: String,
    caller_epoch: u64,
    sender_id: u64,
    caller_workspace_id: String,
    caller_session_id: String,
    workspace_id: String,
    workspace_locator: String,
    workspace_authority_instance: u64,
    workspace_recovery_generation: u64,
    revocation_generation: u64,
}

#[cfg(feature = "native-current-human-capture")]
impl ChatInputCaptureOwner {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        profile_id: String,
        caller_id: String,
        caller_epoch: u64,
        sender_id: u64,
        caller_workspace_id: String,
        caller_session_id: String,
        workspace_id: String,
        workspace_locator: String,
        workspace_authority_instance: u64,
        workspace_recovery_generation: u64,
        revocation_generation: u64,
    ) -> Result<Self> {
        let owner = Self {
            profile_id,
            caller_id,
            caller_epoch,
            sender_id,
            caller_workspace_id,
            caller_session_id,
            workspace_id,
            workspace_locator,
            workspace_authority_instance,
            workspace_recovery_generation,
            revocation_generation,
        };
        owner.validate()?;
        Ok(owner)
    }

    pub fn revocation_generation(&self) -> u64 {
        self.revocation_generation
    }

    pub fn same_capture_incarnation(&self, other: &Self) -> bool {
        self.profile_id == other.profile_id
            && self.caller_id == other.caller_id
            && self.caller_epoch == other.caller_epoch
            && self.sender_id == other.sender_id
            && self.caller_workspace_id == other.caller_workspace_id
            && self.caller_session_id == other.caller_session_id
            && self.workspace_id == other.workspace_id
            && self.workspace_locator == other.workspace_locator
            && self.workspace_authority_instance == other.workspace_authority_instance
            && self.workspace_recovery_generation == other.workspace_recovery_generation
    }

    fn validate(&self) -> Result<()> {
        for value in [
            &self.profile_id,
            &self.caller_id,
            &self.caller_workspace_id,
            &self.caller_session_id,
            &self.workspace_id,
            &self.workspace_locator,
        ] {
            identity(value)?;
        }
        ensure!(self.sender_id > 0, "NIR1_CHAT_CAPTURE_OWNER_INVALID");
        ensure!(
            self.caller_workspace_id == self.workspace_locator
                && self.workspace_authority_instance > 0,
            "NIR1_CHAT_CAPTURE_OWNER_INVALID"
        );
        Ok(())
    }
}

/// Untrusted existing-chat submission fields. IDs are insertion/correlation
/// inputs only; no message-version ID or asserted origin is accepted.
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatInputCaptureCancellationOutcome {
    Cancelled,
    NotCurrent,
    NotFound,
}

#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatInputCaptureRetirementOutcome {
    Retired,
    NotCurrent,
}

#[cfg(feature = "native-current-human-capture")]
pub struct NewChatInputSubmission {
    submission_id: String,
    message_id: String,
    chat_session_id: String,
    scene_id: String,
    content: String,
    created_at: String,
}

#[cfg(feature = "native-current-human-capture")]
impl NewChatInputSubmission {
    pub fn new(
        submission_id: String,
        message_id: String,
        chat_session_id: String,
        scene_id: String,
        content: String,
        created_at: String,
    ) -> Result<Self> {
        let submission = Self {
            submission_id,
            message_id,
            chat_session_id,
            scene_id,
            content,
            created_at,
        };
        submission.validate()?;
        Ok(submission)
    }

    fn validate(&self) -> Result<i64> {
        for value in [
            &self.submission_id,
            &self.message_id,
            &self.chat_session_id,
            &self.scene_id,
        ] {
            identity(value)?;
        }
        ensure!(
            !self.content.trim().is_empty() && self.content.len() <= MAX_MESSAGE_BODY_BYTES,
            "NIR1_GENERATION_MESSAGE_BODY_LIMIT"
        );
        ensure!(
            !self.created_at.is_empty() && self.created_at.len() <= MAX_SHORT_TEXT_BYTES,
            "NIR1_GENERATION_MESSAGE_METADATA_LIMIT"
        );
        Ok(chrono::DateTime::parse_from_rfc3339(&self.created_at)
            .context("NIR1_CHAT_CAPTURE_TIMESTAMP_INVALID")?
            .timestamp_millis())
    }
}

/// Native writer result. Its private fields prevent preparation from being
/// constructed from a caller-selected historical message-version ID.
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedChatInputCapture {
    capture_id: String,
    project_id: String,
    chat_session_id: String,
    scene_id: String,
    submission_id: String,
    submission_digest: String,
    message_id: String,
    message_version_id: String,
    owner: ChatInputCaptureOwner,
}

#[cfg(feature = "native-current-human-capture")]
impl AcceptedChatInputCapture {
    pub fn capture_id(&self) -> &str {
        &self.capture_id
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn chat_session_id(&self) -> &str {
        &self.chat_session_id
    }

    pub fn scene_id(&self) -> &str {
        &self.scene_id
    }

    pub fn submission_id(&self) -> &str {
        &self.submission_id
    }

    pub fn message_id(&self) -> &str {
        &self.message_id
    }

    pub fn message_version_id(&self) -> &str {
        &self.message_version_id
    }

    pub(crate) fn owner(&self) -> &ChatInputCaptureOwner {
        &self.owner
    }
}

/// Canonical text and thinking live only in the existing chat_messages row.
/// Thinking uses the existing metadata.thinking_blocks representation.
#[derive(Clone, Debug)]
pub struct NewMessageBody {
    pub message_id: String,
    pub content: String,
    pub thinking: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureClassification {
    InvalidOutput,
    DispatchUnavailable,
    Cancelled,
    Skipped,
    InterruptedUnknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetryClassification {
    NotApplicable,
    NewAttemptRequired,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredTerminal {
    pub attempt_id: String,
    pub payload_digest: String,
    pub input_digest: String,
    pub message_version: Option<MessageVersion>,
    pub observation: Value,
    pub failure_classification: Option<FailureClassification>,
    pub retry_classification: RetryClassification,
    pub completed_at_ms: i64,
    pub receipt_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedObservation {
    digest_version: String,
    provider_terminal: Option<ProviderTerminal>,
    terminal_status: TerminalStatus,
    parse_status: ParseStatus,
    text_digest: String,
    thinking_digest: String,
    response_digest: Option<String>,
}

fn identity(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.trim() == value && value.len() <= MAX_ID_BYTES,
        "NIR1_GENERATION_INVALID_ID"
    );
    Ok(())
}

fn digest(value: &str) -> Result<()> {
    ensure!(
        value
            .strip_prefix("sha256:")
            .is_some_and(|hex| hex.len() == 64
                && hex
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))),
        "NIR1_GENERATION_INVALID_DIGEST"
    );
    Ok(())
}

/// Shape of a current binding. The database-side checks are in
/// `require_bound_session_and_scene`.
fn validate_binding(binding: &AttemptBinding) -> Result<()> {
    for value in [
        &binding.project_id,
        &binding.chat_session_id,
        &binding.scene.scene_id,
        &binding.scene.scene_incarnation_id,
        &binding.scene.source_token,
        &binding.caller.profile_id,
        &binding.caller.caller_id,
        &binding.caller.caller_session_id,
        &binding.route_revision,
        &binding.provider,
        &binding.model,
        &binding.api,
    ] {
        identity(value)?;
    }
    for value in [
        &binding.scene.body_digest,
        &binding.workspace_binding_digest,
        &binding.scope_digest,
        &binding.material_digest,
        &binding.d1_digest,
        &binding.endpoint_identity,
    ] {
        digest(value)?;
    }
    // Main's caller session and the chat session are separate namespaces.
    // Equal values mean one was assembled from the other.
    ensure!(
        binding.chat_session_id != binding.caller.caller_session_id,
        "NIR1_GENERATION_SESSION_CONFUSION"
    );
    Ok(())
}

fn validate_legacy_binding(binding: &LegacyAttemptBindingV1) -> Result<()> {
    for value in [
        &binding.project_id,
        &binding.session_id,
        &binding.profile_id,
        &binding.caller_id,
        &binding.route_revision,
        &binding.provider,
        &binding.model,
        &binding.api,
    ] {
        identity(value)?;
    }
    for value in [
        &binding.workspace_binding_digest,
        &binding.scope_digest,
        &binding.material_digest,
        &binding.d1_digest,
        &binding.endpoint_identity,
    ] {
        digest(value)?;
    }
    Ok(())
}

/// The single parser of a stored `binding_json`. An explicit `bindingVersion`
/// selects the struct before the whole value is parsed, and both structs deny
/// unknown fields. A later version adds an arm here; until then it is
/// rejected.
fn parse_attempt_binding(json: &str) -> Result<VersionedAttemptBinding> {
    match parse_attempt_binding_lenient(json)? {
        LenientAttemptBinding::Versioned(binding) => Ok(binding),
        LenientAttemptBinding::UnsupportedVersion => {
            anyhow::bail!(BINDING_VERSION_UNSUPPORTED_ERROR)
        }
    }
}

/// A stored binding whose `bindingVersion` this build may not know. Only the
/// history snapshot reader keeps the unknown-version case as a value (HC-1);
/// every other reader goes through `parse_attempt_binding`, which rejects it.
#[expect(
    clippy::large_enum_variant,
    reason = "a transient parse result, matched at once; the versioned variant is the common case"
)]
enum LenientAttemptBinding {
    Versioned(VersionedAttemptBinding),
    UnsupportedVersion,
}

fn parse_attempt_binding_lenient(json: &str) -> Result<LenientAttemptBinding> {
    let probe: AttemptBindingVersionProbe =
        serde_json::from_str(json).context("NIR1_GENERATION_BINDING_INVALID")?;
    match probe.binding_version {
        // v1 never wrote the key. An explicit null is not a version either:
        // the v1 struct then rejects `bindingVersion` as an unknown field.
        None => {
            let legacy: LegacyAttemptBindingV1 =
                serde_json::from_str(json).context("NIR1_GENERATION_BINDING_INVALID")?;
            validate_legacy_binding(&legacy)?;
            Ok(LenientAttemptBinding::Versioned(
                VersionedAttemptBinding::LegacyV1(legacy),
            ))
        }
        Some(Value::Number(version)) if version.as_u64() == Some(ATTEMPT_BINDING_VERSION) => {
            let binding: AttemptBinding =
                serde_json::from_str(json).context("NIR1_GENERATION_BINDING_INVALID")?;
            validate_binding(&binding)?;
            Ok(LenientAttemptBinding::Versioned(
                VersionedAttemptBinding::Current(binding),
            ))
        }
        Some(_) => Ok(LenientAttemptBinding::UnsupportedVersion),
    }
}

impl VersionedAttemptBinding {
    /// The attempt row's `project_id`/`session_id` columns are the binding's
    /// project and chat session.
    fn ensure_attempt_row_identity(&self, project_id: &str, session_id: &str) -> Result<()> {
        let (bound_project, bound_session) = match self {
            Self::LegacyV1(legacy) => (&legacy.project_id, &legacy.session_id),
            Self::Current(binding) => (&binding.project_id, &binding.chat_session_id),
        };
        ensure!(
            bound_project == project_id && bound_session == session_id,
            "NIR1_GENERATION_BINDING_MISMATCH"
        );
        Ok(())
    }

    /// Claim, dispatch, parent lineage, history and a success body need the
    /// current format. A legacy row may only be terminalized.
    fn into_current(self) -> Result<AttemptBinding> {
        match self {
            Self::Current(binding) => Ok(binding),
            Self::LegacyV1(_) => anyhow::bail!(BINDING_LEGACY_TERMINAL_ONLY_ERROR),
        }
    }
}

/// Parse a stored binding and check it against its attempt row. Every reader
/// of `binding_json` goes through this function.
fn read_stored_binding(
    binding_json: &str,
    project_id: &str,
    session_id: &str,
) -> Result<VersionedAttemptBinding> {
    let binding = parse_attempt_binding(binding_json)?;
    binding.ensure_attempt_row_identity(project_id, session_id)?;
    Ok(binding)
}

/// The history snapshot reader's variant of `read_stored_binding`: a legacy
/// or unknown-version row is returned as a value so the reader can exclude
/// it. A malformed binding, or a binding that disagrees with its row, is still
/// an error and fails the whole read.
fn read_stored_binding_lenient(
    binding_json: &str,
    project_id: &str,
    session_id: &str,
) -> Result<LenientAttemptBinding> {
    let binding = parse_attempt_binding_lenient(binding_json)?;
    if let LenientAttemptBinding::Versioned(versioned) = &binding {
        versioned.ensure_attempt_row_identity(project_id, session_id)?;
    }
    Ok(binding)
}

/// The final input digest over version 2 reference rows (`INPUT_DIGEST_DOMAIN`).
pub fn input_digest(
    inputs: &[InputReference],
    qualifications: &[QualificationReference],
) -> Result<String> {
    Ok(canonical_json_digest(
        &json!({"domain":INPUT_DIGEST_DOMAIN,
        "inputs":inputs,"qualifications":qualifications}),
    )?)
}

/// The digest over version 1 reference rows, which this build only verifies.
fn legacy_input_digest(
    inputs: &[LegacyInputReferenceV1],
    qualifications: &[LegacyQualificationReferenceV1],
) -> Result<String> {
    Ok(canonical_json_digest(
        &json!({"domain":LEGACY_INPUT_DIGEST_DOMAIN_V1,
        "inputs":inputs,"qualifications":qualifications}),
    )?)
}

/// Read the current binding values of one live, unarchived Scene inside the
/// caller's transaction. Create and claim compare them with
/// `AttemptBinding.scene`, and a coordinator builds that value with this same
/// reader in the snapshot it packs from. Scalar lengths are admitted before
/// any String is materialized, the stored body is bounded by the Packing input
/// ceiling, and only its digest is returned. A Scene without its Native scope
/// incarnation row is unavailable.
pub fn read_attempt_scene_binding_in_tx(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> Result<AttemptSceneBinding> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1_GENERATION_TRANSACTION_REQUIRED"
    );
    identity(project_id)?;
    identity(scene_id)?;
    let lengths: Option<(i64, i64, i64, bool, Option<i64>)> = conn
        .query_row(
            "SELECT t.version,octet_length(t.updated_at),octet_length(t.content),
                    t.archived_at IS NOT NULL,octet_length(b.scene_incarnation_id)
               FROM tree_nodes t
               LEFT JOIN narrative_scene_scope_bindings b
                 ON b.project_id=t.project_id AND b.scene_id=t.id
              WHERE t.id=?1 AND t.project_id=?2 AND t.node_type='scene'",
            params![scene_id, project_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let (version, updated_at_length, content_length, archived, incarnation_length) =
        lengths.context("NIR1_GENERATION_SCENE_UNAVAILABLE")?;
    let incarnation_length = incarnation_length.context("NIR1_GENERATION_SCENE_UNAVAILABLE")?;
    ensure!(!archived, "NIR1_GENERATION_SCENE_ARCHIVED");
    ensure!(
        version >= 0 && updated_at_length > 0,
        "NIR1_GENERATION_SCENE_UNAVAILABLE"
    );
    let updated_at_length = bounded_sqlite_length(
        updated_at_length,
        MAX_ID_BYTES,
        "NIR1_GENERATION_SCENE_METADATA_LIMIT",
    )?;
    let incarnation_length = bounded_sqlite_length(
        incarnation_length,
        MAX_ID_BYTES,
        "NIR1_GENERATION_SCENE_METADATA_LIMIT",
    )?;
    let content_length = bounded_sqlite_length(
        content_length,
        MAX_PACKING_INPUT_BYTES,
        "NIR1_GENERATION_SCENE_BODY_LIMIT",
    )?;
    let (updated_at, content, scene_incarnation_id): (String, String, String) = conn.query_row(
        "SELECT t.updated_at,t.content,b.scene_incarnation_id
           FROM tree_nodes t
           JOIN narrative_scene_scope_bindings b
             ON b.project_id=t.project_id AND b.scene_id=t.id
          WHERE t.id=?1 AND t.project_id=?2 AND t.node_type='scene'",
        params![scene_id, project_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    ensure!(
        updated_at.len() == updated_at_length
            && content.len() == content_length
            && scene_incarnation_id.len() == incarnation_length,
        "NIR1_GENERATION_SCENE_CHANGED"
    );
    identity(&scene_incarnation_id)?;
    let source_token = format!("v{version}@{updated_at}");
    identity(&source_token)?;
    Ok(AttemptSceneBinding {
        scene_id: scene_id.to_owned(),
        scene_incarnation_id,
        source_token,
        body_digest: format!("sha256:{}", hex::encode(Sha256::digest(content.as_bytes()))),
    })
}

/// Database-side checks of a current binding, run inside the IMMEDIATE
/// transaction of create and of claim (which commits its CAS in that same
/// transaction): the chat session row, the exact live and unarchived Scene
/// incarnation with its source token and body, and the session's attachment
/// to that Scene. The process-local caller is not checked here.
fn require_bound_session_and_scene(conn: &Connection, binding: &AttemptBinding) -> Result<()> {
    let session_on_scene: bool = conn
        .query_row(
            "SELECT node_id IS ?3 FROM chat_sessions WHERE id=?1 AND project_id=?2",
            params![
                binding.chat_session_id,
                binding.project_id,
                binding.scene.scene_id
            ],
            |row| row.get(0),
        )
        .optional()?
        .context("NIR1_GENERATION_SESSION_MISMATCH")?;
    let current =
        read_attempt_scene_binding_in_tx(conn, &binding.project_id, &binding.scene.scene_id)?;
    ensure!(
        current.scene_incarnation_id == binding.scene.scene_incarnation_id,
        "NIR1_GENERATION_SCENE_INCARNATION_MISMATCH"
    );
    ensure!(
        current.source_token == binding.scene.source_token,
        "NIR1_GENERATION_SCENE_SOURCE_STALE"
    );
    ensure!(
        current.body_digest == binding.scene.body_digest,
        "NIR1_GENERATION_SCENE_BODY_MISMATCH"
    );
    ensure!(session_on_scene, "NIR1_GENERATION_SESSION_SCENE_MISMATCH");
    Ok(())
}

fn validate_refs(
    conn: &Connection,
    binding: &AttemptBinding,
    inputs: &[InputReference],
    qualifications: &[QualificationReference],
    budget: ReadBudget,
) -> Result<()> {
    let count = inputs
        .len()
        .checked_add(qualifications.len())
        .context("NIR1_GENERATION_REF_LIMIT")?;
    ensure!(count <= budget.max_references, "NIR1_GENERATION_REF_LIMIT");
    validate_reference_shapes(inputs, qualifications)?;
    let mut bytes = 0usize;
    let mut parent_reference_budget = budget;
    let mut parent_receipts = BTreeMap::<String, Option<(bool, Option<MessageVersion>)>>::new();
    for input in inputs {
        bytes = bytes
            .checked_add(serde_json::to_vec(input)?.len())
            .context("NIR1_GENERATION_REF_LIMIT")?;
        match &input.target {
            InputTarget::Message {
                version_id,
                parent_attempt_id,
            } => {
                let version = read_message_version_in_tx(conn, version_id)?;
                ensure!(
                    version.project_id == binding.project_id
                        && version.session_id == binding.chat_session_id
                        && &version.parent_attempt_id == parent_attempt_id,
                    "NIR1_GENERATION_MESSAGE_BINDING_MISMATCH"
                );
                match version.origin {
                    MessageOrigin::Human => ensure!(
                        input.role == InputRole::User,
                        "NIR1_GENERATION_MESSAGE_ROLE_MISMATCH"
                    ),
                    MessageOrigin::Generated => {
                        ensure!(
                            input.role == InputRole::Assistant,
                            "NIR1_GENERATION_MESSAGE_ROLE_MISMATCH"
                        );
                        let parent_id = parent_attempt_id
                            .as_deref()
                            .context("NIR1_GENERATION_PARENT_REQUIRED")?;
                        let parent_receipt = if let Some(receipt) = parent_receipts.get(parent_id) {
                            receipt.clone()
                        } else {
                            let parent = read_attempt_in_tx_with_remaining(
                                conn,
                                parent_id,
                                &mut parent_reference_budget,
                            )?;
                            let receipt = parent.terminal.map(|terminal| {
                                (
                                    terminal.observation["terminalStatus"] == "succeeded",
                                    terminal.message_version,
                                )
                            });
                            parent_receipts.insert(parent_id.to_owned(), receipt.clone());
                            receipt
                        };
                        let (parent_succeeded, parent_version) =
                            parent_receipt.context("NIR1_GENERATION_PARENT_UNFINISHED")?;
                        ensure!(
                            parent_succeeded && parent_version.as_ref() == Some(&version),
                            "NIR1_GENERATION_PARENT_UNQUALIFIED"
                        );
                    }
                }
            }
            InputTarget::Artifact {
                artifact_id,
                payload_digest,
            } => {
                identity(artifact_id)?;
                digest(payload_digest)?;
                let found_length = conn
                    .query_row(
                        "SELECT octet_length(a.payload_digest)
                         FROM narrative_extraction_artifacts a
                         JOIN narrative_extraction_runs r ON r.id=a.run_id
                         WHERE a.id=?1 AND r.project_id=?2",
                        params![artifact_id, binding.project_id],
                        |row| row.get::<_, Option<i64>>(0),
                    )
                    .optional()?
                    .flatten();
                let found = if let Some(found_length) = found_length {
                    let expected_length = bounded_sqlite_length(
                        found_length,
                        MAX_DIGEST_BYTES,
                        "NIR1_GENERATION_ARTIFACT_DIGEST_LIMIT",
                    )?;
                    let found: String = conn.query_row(
                        "SELECT a.payload_digest
                         FROM narrative_extraction_artifacts a
                         JOIN narrative_extraction_runs r ON r.id=a.run_id
                         WHERE a.id=?1 AND r.project_id=?2",
                        params![artifact_id, binding.project_id],
                        |row| row.get(0),
                    )?;
                    ensure!(
                        found.len() == expected_length,
                        "NIR1_GENERATION_ARTIFACT_DIGEST_CHANGED"
                    );
                    Some(found)
                } else {
                    None
                };
                ensure!(
                    found.as_ref() == Some(payload_digest),
                    "NIR1_GENERATION_ARTIFACT_MISMATCH"
                );
            }
            InputTarget::RawSource {
                source_key,
                revision_token,
            } => {
                identity(source_key)?;
                identity(revision_token)?;
            }
            InputTarget::AcceptedRevision {
                revision_id,
                bundle_digest,
            } => {
                identity(revision_id)?;
                digest(bundle_digest)?;
            }
            InputTarget::GraphEvidence {
                evidence_ref,
                source_key,
                revision_token,
            } => {
                identity(evidence_ref)?;
                identity(source_key)?;
                identity(revision_token)?;
            }
        }
    }
    for reference in qualifications {
        ensure!(
            reference.input_ordinal < inputs.len(),
            "NIR1_GENERATION_QUALIFICATION_INPUT_MISSING"
        );
        if let QualificationBody::Present {
            identity: reference_identity,
            version: reference_version,
            ..
        } = &reference.body
        {
            identity(reference_identity)?;
            identity(reference_version)?;
        }
        bytes = bytes
            .checked_add(serde_json::to_vec(reference)?.len())
            .context("NIR1_GENERATION_REF_LIMIT")?;
    }
    ensure!(
        bytes <= budget.max_reference_bytes,
        "NIR1_GENERATION_REF_LIMIT"
    );
    Ok(())
}

/// Unbounded test-support writer. Production creates use
/// [`create_attempt_for_capture_bounded`] with a deterministic identity.
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub fn create_attempt(db: &Database, request: NewAttempt) -> Result<StoredAttempt> {
    validate_new_attempt(&request)?;
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_bound_session_and_scene(conn, &request.binding)?;
            validate_refs(
                conn,
                &request.binding,
                &request.inputs,
                &request.qualifications,
                request.budget,
            )?;
            insert_attempt_in_tx(conn, &Uuid::new_v4().to_string(), &request, true)
        })
    })
}

// Production creates exist only in the Native capture build.
#[cfg_attr(not(feature = "native-current-human-capture"), allow(dead_code))]
fn validate_new_attempt(request: &NewAttempt) -> Result<()> {
    validate_binding(&request.binding)?;
    digest(&request.payload_digest)?;
    ensure!(
        request.created_at_ms >= 0 && request.expires_at_ms > request.created_at_ms,
        "NIR1_GENERATION_INVALID_EXPIRY"
    );
    Ok(())
}

const HISTORY_SLOT_REQUIRED_ERROR: &str = "NIR1_GENERATION_HISTORY_SLOT_REQUIRED";

/// The `AttemptBinding` that the storage writer stores for `request`
/// (K4/3 section 2), as a pure function of the request. The writer does not
/// trust the caller's history slots; in this order it
///
/// 1. refuses a null `historyTurnContext` (the product create always records
///    a context or a closed reason; only test-support writes null) and a slot
///    of an unknown contract (read-only),
/// 2. sets a context's `eligibleUntilMs` to the row's `created_at_ms` plus 30
///    days (`eligibility-overflow` if that leaves the safe range),
/// 3. turns a context into `d-final-incomplete` when the input and
///    qualification rows violate the completeness rule (structure only; the
///    expected-set rule needs the D-final state and is checked by the builder),
/// 4. turns a context without a durable identity into
///    `workspace-identity-unavailable`,
/// 5. when the canonical JSON exceeds 64 KiB, turns the history slot into
///    `binding-limit` and drops the durable identity; if even that exceeds
///    64 KiB (the binding fits only with null slots) the slot becomes null;
///    if it exceeds 64 KiB with null slots, or a slot-free binding exceeds
///    it, the binding is refused (`NIR1_GENERATION_BINDING_LIMIT`).
///
/// The owner compares a re-read row with this value, so a COMMIT whose result
/// is unknown still matches after a downgrade.
pub fn effective_attempt_binding(request: &NewAttempt) -> Result<AttemptBinding> {
    effective_attempt_binding_with_json(request, false).map(|(binding, _)| binding)
}

fn effective_attempt_binding_with_json(
    request: &NewAttempt,
    allow_null_slot: bool,
) -> Result<(AttemptBinding, String)> {
    let mut binding = request.binding.clone();
    ensure!(
        !matches!(
            binding.history_turn_context,
            Some(HistoryContextSlot::UnknownContract)
        ),
        "{}",
        SLOT_UNWRITABLE_ERROR
    );
    ensure!(
        allow_null_slot || binding.history_turn_context.is_some(),
        "{}",
        HISTORY_SLOT_REQUIRED_ERROR
    );
    if let Some(HistoryContextSlot::Context(context)) = binding.history_turn_context.as_mut() {
        let downgrade = if let Some(until) = eligible_until_ms(request.created_at_ms) {
            context.eligible_until_ms = until;
            if check_attempt_completeness(
                &request.inputs,
                &request.qualifications,
                &CompletenessContext {
                    target_scene_id: &binding.scene.scene_id,
                    expected_targets: None,
                },
            )
            .is_err()
            {
                Some(HistoryUnavailableReason::DFinalIncomplete)
            } else if binding.durable_workspace_identity.is_none() {
                Some(HistoryUnavailableReason::WorkspaceIdentityUnavailable)
            } else {
                None
            }
        } else {
            Some(HistoryUnavailableReason::EligibilityOverflow)
        };
        if let Some(reason) = downgrade {
            binding.history_turn_context = Some(HistoryContextSlot::Unavailable(reason));
        }
    }
    let mut binding_json = canonical_json_string(&serde_json::to_value(&binding)?)?;
    if binding_json.len() > MAX_BINDING_JSON_BYTES
        && (binding.history_turn_context.is_some() || binding.durable_workspace_identity.is_some())
    {
        binding.history_turn_context = Some(HistoryContextSlot::Unavailable(
            HistoryUnavailableReason::BindingLimit,
        ));
        binding.durable_workspace_identity = None;
        binding_json = canonical_json_string(&serde_json::to_value(&binding)?)?;
        if binding_json.len() > MAX_BINDING_JSON_BYTES {
            // The binding fits without any slot but not with the closed
            // reason (a band of about 70 bytes): do not stop the send for a
            // history record. The attempt is stored with null slots, which no
            // history reader uses.
            binding.history_turn_context = None;
            binding_json = canonical_json_string(&serde_json::to_value(&binding)?)?;
        }
    }
    ensure!(
        binding_json.len() <= MAX_BINDING_JSON_BYTES,
        "NIR1_GENERATION_BINDING_LIMIT"
    );
    Ok((binding, binding_json))
}

// Production creates exist only in the Native capture build.
#[cfg_attr(not(feature = "native-current-human-capture"), allow(dead_code))]
/// Insert one already validated attempt and its ordered reference rows. The
/// caller owns the immediate transaction and has validated the references.
/// The stored binding is [`effective_attempt_binding`] (a null history slot
/// is allowed only when `allow_null_slot`, which test-support sets).
fn insert_attempt_in_tx(
    conn: &Connection,
    id: &str,
    request: &NewAttempt,
    allow_null_slot: bool,
) -> Result<StoredAttempt> {
    identity(id)?;
    validate_reference_shapes(&request.inputs, &request.qualifications)?;
    let input_digest = input_digest(&request.inputs, &request.qualifications)?;
    let (binding, binding_json) = effective_attempt_binding_with_json(request, allow_null_slot)?;
    conn.execute(
        "INSERT INTO nir1_generation_attempts
        (id,project_id,session_id,binding_json,payload_digest,input_digest,created_at_ms,expires_at_ms)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            id,
            binding.project_id,
            binding.chat_session_id,
            binding_json,
            request.payload_digest,
            input_digest,
            request.created_at_ms,
            request.expires_at_ms
        ],
    )?;
    for (ordinal, reference) in request.inputs.iter().enumerate() {
        conn.execute(
            "INSERT INTO nir1_generation_input_refs VALUES (?1,?2,?3)",
            params![
                id,
                i64::try_from(ordinal)?,
                canonical_json_string(&serde_json::to_value(reference)?)?
            ],
        )?;
    }
    for (ordinal, reference) in request.qualifications.iter().enumerate() {
        conn.execute(
            "INSERT INTO nir1_generation_qualification_refs VALUES (?1,?2,?3)",
            params![
                id,
                i64::try_from(ordinal)?,
                canonical_json_string(&serde_json::to_value(reference)?)?
            ],
        )?;
    }
    Ok(StoredAttempt {
        id: id.to_owned(),
        binding,
        payload_digest: request.payload_digest.clone(),
        input_digest,
        inputs: request.inputs.clone(),
        qualifications: request.qualifications.clone(),
        reference_format: ReferenceFormat::V2,
        created_at_ms: request.created_at_ms,
        expires_at_ms: request.expires_at_ms,
        claimed_at_ms: None,
        terminal: None,
    })
}

/// Scalar-only reference admission. Limits apply jointly to both lists when
/// the same `ReadBudget` is passed through each table. The point fetch is
/// deliberately separate so no imported JSON is materialized before the
/// caller has admitted the whole attempt's reference page.
fn read_ref_locations_in_tx(
    conn: &Connection,
    table: &str,
    id: &str,
    remaining: &mut ReadBudget,
) -> Result<Vec<(i64, usize)>> {
    let count = i64::try_from(remaining.max_references)?
        .checked_add(1)
        .context("NIR1_GENERATION_REF_LIMIT")?;
    let sql = format!(
        "SELECT ordinal,octet_length(reference_json)
        FROM {table} WHERE attempt_id=?1 ORDER BY ordinal LIMIT ?2"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params![id, count])?;
    let mut locations = Vec::new();
    let mut page_bytes = 0usize;
    while let Some(row) = rows.next()? {
        let ordinal = row.get::<_, i64>(0)?;
        ensure!(
            ordinal == i64::try_from(locations.len())?,
            "NIR1_GENERATION_REF_ORDINAL_MISMATCH"
        );
        ensure!(
            locations.len() < remaining.max_references,
            "NIR1_GENERATION_REF_LIMIT"
        );
        let bytes = bounded_sqlite_length(
            row.get::<_, i64>(1)?,
            remaining.max_reference_bytes,
            "NIR1_GENERATION_REF_LIMIT",
        )?;
        page_bytes = page_bytes
            .checked_add(bytes)
            .context("NIR1_GENERATION_REF_LIMIT")?;
        ensure!(
            page_bytes <= remaining.max_reference_bytes,
            "NIR1_GENERATION_REF_LIMIT"
        );
        locations.push((ordinal, bytes));
    }
    drop(rows);

    remaining.max_references -= locations.len();
    remaining.max_reference_bytes -= page_bytes;
    Ok(locations)
}

fn materialize_refs_in_tx<T>(
    conn: &Connection,
    table: &str,
    id: &str,
    locations: &[(i64, usize)],
    cancellation: Option<&GenerationHistorySnapshotCancellation>,
    parse: fn(&str) -> Result<T>,
) -> Result<Vec<T>> {
    let point_sql =
        format!("SELECT reference_json FROM {table} WHERE attempt_id=?1 AND ordinal=?2");
    let mut point = conn.prepare(&point_sql)?;
    let mut result = Vec::with_capacity(locations.len());
    for &(ordinal, expected_bytes) in locations {
        if let Some(cancellation) = cancellation {
            cancellation.checkpoint()?;
        }
        let raw: String = point.query_row(params![id, ordinal], |row| row.get(0))?;
        ensure!(
            raw.len() == expected_bytes,
            "NIR1_GENERATION_REF_LENGTH_CHANGED"
        );
        if let Some(cancellation) = cancellation {
            cancellation.checkpoint()?;
        }
        let value = parse(&raw)?;
        if let Some(cancellation) = cancellation {
            cancellation.checkpoint()?;
        }
        result.push(value);
    }
    Ok(result)
}

fn sum_materialization_bytes<I>(parts: I) -> Result<usize>
where
    I: IntoIterator<Item = usize>,
{
    parts.into_iter().try_fold(0usize, |total, bytes| {
        total
            .checked_add(bytes)
            .context("NIR1_GENERATION_HISTORY_BODY_LIMIT")
    })
}

/// Scalar-only admission for the owned attempt metadata and its raw reference
/// rows. This is separate from `ReadBudget`: the latter limits child-ref
/// lookup, while the history turn ledger limits retained/materialized bytes.
fn attempt_metadata_materialization_bytes_in_tx(conn: &Connection, id: &str) -> Result<usize> {
    let lengths: (i64, i64, i64, i64, i64) = conn
        .query_row(
            "SELECT octet_length(project_id),octet_length(session_id),
                    octet_length(binding_json),octet_length(payload_digest),
                    octet_length(input_digest)
             FROM nir1_generation_attempts WHERE id=?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?
        .context("NIR1_GENERATION_ATTEMPT_MISSING")?;
    let metadata = [
        bounded_sqlite_length(
            lengths.0,
            MAX_ID_BYTES,
            "NIR1_GENERATION_ATTEMPT_METADATA_LIMIT",
        )?,
        bounded_sqlite_length(
            lengths.1,
            MAX_ID_BYTES,
            "NIR1_GENERATION_ATTEMPT_METADATA_LIMIT",
        )?,
        bounded_sqlite_length(
            lengths.2,
            MAX_BINDING_JSON_BYTES,
            "NIR1_GENERATION_BINDING_LIMIT",
        )?,
        bounded_sqlite_length(lengths.3, MAX_DIGEST_BYTES, "NIR1_GENERATION_DIGEST_LIMIT")?,
        bounded_sqlite_length(lengths.4, MAX_DIGEST_BYTES, "NIR1_GENERATION_DIGEST_LIMIT")?,
    ];
    sum_materialization_bytes(metadata)
}

struct AttemptMetadata {
    project_id: String,
    session_id: String,
    binding_json: String,
    payload_digest: String,
    input_digest: String,
    created_at_ms: i64,
    expires_at_ms: i64,
    claimed_at_ms: Option<i64>,
}

fn read_attempt_metadata_in_tx(conn: &Connection, id: &str) -> Result<AttemptMetadata> {
    identity(id)?;
    let lengths: (i64, i64, i64, i64, i64, i64, i64, Option<i64>) = conn
        .query_row(
            "SELECT octet_length(project_id),octet_length(session_id),
        octet_length(binding_json),octet_length(payload_digest),octet_length(input_digest),
        created_at_ms,expires_at_ms,claimed_at_ms
        FROM nir1_generation_attempts WHERE id=?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                ))
            },
        )
        .optional()?
        .context("NIR1_GENERATION_ATTEMPT_MISSING")?;
    bounded_sqlite_length(
        lengths.0,
        MAX_ID_BYTES,
        "NIR1_GENERATION_ATTEMPT_METADATA_LIMIT",
    )?;
    bounded_sqlite_length(
        lengths.1,
        MAX_ID_BYTES,
        "NIR1_GENERATION_ATTEMPT_METADATA_LIMIT",
    )?;
    bounded_sqlite_length(
        lengths.2,
        MAX_BINDING_JSON_BYTES,
        "NIR1_GENERATION_BINDING_LIMIT",
    )?;
    bounded_sqlite_length(lengths.3, MAX_DIGEST_BYTES, "NIR1_GENERATION_DIGEST_LIMIT")?;
    bounded_sqlite_length(lengths.4, MAX_DIGEST_BYTES, "NIR1_GENERATION_DIGEST_LIMIT")?;
    let values: (String, String, String, String, String) = conn.query_row(
        "SELECT project_id,session_id,binding_json,payload_digest,input_digest
         FROM nir1_generation_attempts WHERE id=?1",
        [id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    digest(&values.3)?;
    digest(&values.4)?;
    Ok(AttemptMetadata {
        project_id: values.0,
        session_id: values.1,
        binding_json: values.2,
        payload_digest: values.3,
        input_digest: values.4,
        created_at_ms: lengths.5,
        expires_at_ms: lengths.6,
        claimed_at_ms: lengths.7,
    })
}

fn read_attempt_in_tx_with_remaining(
    conn: &Connection,
    id: &str,
    remaining: &mut ReadBudget,
) -> Result<StoredAttempt> {
    let mut no_reserve = |_bytes: usize| Ok(());
    match read_attempt_in_tx_with_remaining_and_reserve(
        conn,
        id,
        remaining,
        &mut no_reserve,
        None,
        false,
    )? {
        GenerationHistoryAttempt::Stored(stored) => Ok(stored),
        // Only the history gate returns a header, and it is off here.
        GenerationHistoryAttempt::Excluded(_) => {
            anyhow::bail!("NIR1_GENERATION_HISTORY_ATTEMPT_UNUSABLE")
        }
    }
}

/// The closed reason a history reader does not use this attempt, decided from
/// the binding's `historyTurnContext` slot alone (K4/3 section 2). `None`
/// means the slot is a context of the known version.
fn history_gate_reason(binding: &AttemptBinding) -> Option<HistoryContextGateReason> {
    HistoryContextGateReason::of(binding.history_turn_context.as_ref())
}

/// The attempt row as the history gate returns it: the header and binding
/// only. No reference row was read, so `inputs` and `qualifications` are
/// empty, the digests are the stored columns (not recomputed) and no
/// terminal was read.
fn gated_history_attempt(
    id: &str,
    stored: AttemptMetadata,
    binding: AttemptBinding,
) -> StoredAttempt {
    StoredAttempt {
        id: id.to_owned(),
        binding,
        payload_digest: stored.payload_digest,
        input_digest: stored.input_digest,
        inputs: Vec::new(),
        qualifications: Vec::new(),
        reference_format: ReferenceFormat::V2,
        created_at_ms: stored.created_at_ms,
        expires_at_ms: stored.expires_at_ms,
        claimed_at_ms: stored.claimed_at_ms,
        terminal: None,
    }
}

fn read_attempt_in_tx_with_remaining_and_reserve<F>(
    conn: &Connection,
    id: &str,
    remaining: &mut ReadBudget,
    reserve: &mut F,
    cancellation: Option<&GenerationHistorySnapshotCancellation>,
    history_gate: bool,
) -> Result<GenerationHistoryAttempt>
where
    F: FnMut(usize) -> Result<()>,
{
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    // `history_gate` is true only for the history snapshot reader (HS1-2).
    // The history gate reads the binding before any reference row. A slot
    // that is not a known-version context returns the header alone: no
    // reference row is read and neither the reference budget nor the body
    // byte reservation is debited. A legacy (version 1) binding and a
    // binding of an unknown version are excluded the same way (HC-1, K4/3
    // section 6): the closed reason is returned and nothing else is read. A
    // malformed binding is still an error. Every other reader keeps the full
    // read and its terminal-only refusal.
    let prefetched = if history_gate {
        let stored = read_attempt_metadata_in_tx(conn, id)?;
        if let Some(cancellation) = cancellation {
            cancellation.checkpoint()?;
        }
        let binding = read_stored_binding_lenient(
            &stored.binding_json,
            &stored.project_id,
            &stored.session_id,
        )?;
        let excluded = |reason| {
            GenerationHistoryAttempt::Excluded(ExcludedHistoryAttempt::new(
                id,
                &stored.project_id,
                &stored.session_id,
                stored.created_at_ms,
                reason,
            ))
        };
        match binding {
            LenientAttemptBinding::UnsupportedVersion => {
                return Ok(excluded(
                    HistoryContextGateReason::UnsupportedBindingVersion,
                ));
            }
            LenientAttemptBinding::Versioned(VersionedAttemptBinding::LegacyV1(_)) => {
                return Ok(excluded(HistoryContextGateReason::LegacyBinding));
            }
            LenientAttemptBinding::Versioned(VersionedAttemptBinding::Current(current))
                if history_gate_reason(&current).is_some() =>
            {
                return Ok(GenerationHistoryAttempt::Stored(gated_history_attempt(
                    id, stored, current,
                )));
            }
            LenientAttemptBinding::Versioned(binding) => Some((stored, binding)),
        }
    } else {
        None
    };
    let metadata_bytes = attempt_metadata_materialization_bytes_in_tx(conn, id)?;
    let mut reference_budget = *remaining;
    let input_locations = read_ref_locations_in_tx(
        conn,
        "nir1_generation_input_refs",
        id,
        &mut reference_budget,
    )?;
    let qualification_locations = read_ref_locations_in_tx(
        conn,
        "nir1_generation_qualification_refs",
        id,
        &mut reference_budget,
    )?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let reference_bytes = sum_materialization_bytes(
        input_locations
            .iter()
            .chain(qualification_locations.iter())
            .map(|(_, bytes)| *bytes),
    )?;
    reserve(sum_materialization_bytes([
        metadata_bytes,
        reference_bytes,
    ])?)?;
    *remaining = reference_budget;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let (stored, prefetched_binding) = match prefetched {
        Some((stored, binding)) => (stored, Some(binding)),
        None => (read_attempt_metadata_in_tx(conn, id)?, None),
    };
    let input_rows = materialize_refs_in_tx(
        conn,
        "nir1_generation_input_refs",
        id,
        &input_locations,
        cancellation,
        parse_versioned_reference::<InputReference, LegacyInputReferenceV1>,
    )?;
    let qualification_rows = materialize_refs_in_tx(
        conn,
        "nir1_generation_qualification_refs",
        id,
        &qualification_locations,
        cancellation,
        parse_versioned_reference::<QualificationReference, LegacyQualificationReferenceV1>,
    )?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let VersionedReferences {
        format: reference_format,
        inputs,
        qualifications,
        computed_digest,
    } = read_versioned_references(input_rows, qualification_rows, &stored.input_digest)?;
    ensure!(
        computed_digest == stored.input_digest,
        "NIR1_GENERATION_INPUT_DIGEST_MISMATCH"
    );
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let binding = match prefetched_binding {
        Some(binding) => binding,
        None => read_stored_binding(&stored.binding_json, &stored.project_id, &stored.session_id)?,
    };
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    // Claims, parent lineage and history read attempts through this function,
    // so a legacy row is reachable only through terminalization.
    let binding = binding.into_current()?;
    Ok(GenerationHistoryAttempt::Stored(StoredAttempt {
        id: id.to_owned(),
        binding,
        payload_digest: stored.payload_digest,
        input_digest: stored.input_digest,
        inputs,
        qualifications,
        reference_format,
        created_at_ms: stored.created_at_ms,
        expires_at_ms: stored.expires_at_ms,
        claimed_at_ms: stored.claimed_at_ms,
        terminal: read_terminal_in_tx_with_reserve(conn, id, reserve, false, cancellation)?,
    }))
}

fn read_attempt_in_tx(conn: &Connection, id: &str, budget: ReadBudget) -> Result<StoredAttempt> {
    let mut remaining = budget;
    read_attempt_in_tx_with_remaining(conn, id, &mut remaining)
}

/// Unbounded test-support reader. Owners use [`read_attempt_exact_bounded`].
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub fn read_attempt(db: &Database, id: &str, budget: ReadBudget) -> Result<StoredAttempt> {
    db.with_read_transaction(|conn| read_attempt_in_tx(conn, id, budget))
}

fn message_body_lengths_in_tx(
    conn: &Connection,
    message: &str,
    project: &str,
    session: &str,
) -> Result<(usize, usize, Option<usize>, usize)> {
    let lengths: (i64, i64, Option<i64>, i64) = conn
        .query_row(
            "SELECT octet_length(m.role),octet_length(m.content),
                    octet_length(m.metadata),octet_length(m.created_at)
             FROM chat_messages m
             JOIN chat_sessions s ON s.id=m.session_id
             WHERE m.id=?1 AND m.session_id=?2 AND s.project_id=?3",
            params![message, session, project],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?
        .context("NIR1_GENERATION_MESSAGE_BODY_MISSING")?;
    let role = bounded_sqlite_length(
        lengths.0,
        MAX_SHORT_TEXT_BYTES,
        "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
    )?;
    let content = bounded_sqlite_length(
        lengths.1,
        MAX_MESSAGE_BODY_BYTES,
        "NIR1_GENERATION_MESSAGE_BODY_LIMIT",
    )?;
    let metadata = bounded_optional_sqlite_length(
        lengths.2,
        MAX_MESSAGE_METADATA_BYTES,
        "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
    )?;
    let created_at = bounded_sqlite_length(
        lengths.3,
        MAX_SHORT_TEXT_BYTES,
        "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
    )?;
    Ok((role, content, metadata, created_at))
}

fn read_message_body_after_preflight_in_tx(
    conn: &Connection,
    message: &str,
    project: &str,
    session: &str,
    lengths: (usize, usize, Option<usize>, usize),
    cancellation: Option<&GenerationHistorySnapshotCancellation>,
) -> Result<(String, String, Option<Value>, String)> {
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let (role, content, metadata, created_at): (String, String, Option<String>, String) = conn
        .query_row(
            "SELECT m.role,m.content,m.metadata,m.created_at
             FROM chat_messages m
             JOIN chat_sessions s ON s.id=m.session_id
             WHERE m.id=?1 AND m.session_id=?2 AND s.project_id=?3",
            params![message, session, project],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    ensure!(
        role.len() == lengths.0,
        "NIR1_GENERATION_MESSAGE_BODY_CHANGED"
    );
    ensure!(
        content.len() == lengths.1,
        "NIR1_GENERATION_MESSAGE_BODY_CHANGED"
    );
    ensure!(
        metadata.as_ref().map(String::len) == lengths.2,
        "NIR1_GENERATION_MESSAGE_BODY_CHANGED"
    );
    ensure!(
        created_at.len() == lengths.3,
        "NIR1_GENERATION_MESSAGE_BODY_CHANGED"
    );
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let metadata = metadata
        .map(|value| serde_json::from_str::<Value>(&value))
        .transpose()?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    Ok((role, content, metadata, created_at))
}

/// Scalar-only admission for a complete message-version read, including the
/// current chat body used to authenticate its digest. Terminal reads use this
/// before calling `read_message_version_in_tx`, so the turn ledger covers the
/// same transient/owned materialization path as direct message reads.
fn message_version_materialization_bytes_in_tx(conn: &Connection, id: &str) -> Result<usize> {
    let lengths = conn
        .query_row(
            "SELECT octet_length(v.project_id),octet_length(v.session_id),
                    octet_length(v.message_id),octet_length(v.origin),
                    octet_length(v.body_digest),octet_length(v.parent_attempt_id),
                    octet_length(m.role),octet_length(m.content),
                    octet_length(m.metadata),octet_length(m.created_at)
             FROM nir1_generation_message_versions v
             JOIN chat_messages m ON m.id=v.message_id AND m.session_id=v.session_id
             JOIN chat_sessions s ON s.id=v.session_id AND s.project_id=v.project_id
             WHERE v.id=?1 AND v.invalidated=0",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                ))
            },
        )
        .optional()?
        .context("NIR1_GENERATION_MESSAGE_VERSION_MISSING")?;
    let version = [
        bounded_sqlite_length(
            lengths.0,
            MAX_ID_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?,
        bounded_sqlite_length(
            lengths.1,
            MAX_ID_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?,
        bounded_sqlite_length(
            lengths.2,
            MAX_ID_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?,
        bounded_sqlite_length(
            lengths.3,
            MAX_SHORT_TEXT_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?,
        bounded_sqlite_length(lengths.4, MAX_DIGEST_BYTES, "NIR1_GENERATION_DIGEST_LIMIT")?,
        bounded_optional_sqlite_length(
            lengths.5,
            MAX_ID_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?
        .unwrap_or(0),
    ];
    let body = [
        bounded_sqlite_length(
            lengths.6,
            MAX_SHORT_TEXT_BYTES,
            "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
        )?,
        bounded_sqlite_length(
            lengths.7,
            MAX_MESSAGE_BODY_BYTES,
            "NIR1_GENERATION_MESSAGE_BODY_LIMIT",
        )?,
        bounded_optional_sqlite_length(
            lengths.8,
            MAX_MESSAGE_METADATA_BYTES,
            "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
        )?
        .unwrap_or(0),
        bounded_sqlite_length(
            lengths.9,
            MAX_SHORT_TEXT_BYTES,
            "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
        )?,
    ];
    sum_materialization_bytes(version.into_iter().chain(body))
}

/// A read-only view over one SQLite read transaction. Its fields are private
/// so callers can issue only the typed, owned reads below; no raw connection,
/// nested transaction, claim, writer, or transport capability crosses this
/// boundary. `StoredAttempt.binding` contains the persisted coarse digests
/// and the query Scene binding; it is intentionally not a substitute for the
/// full Scope-axis, input-use, purpose, or send-classification tuple required
/// by history.
pub(crate) struct GenerationHistorySnapshotReader<'connection> {
    connection: &'connection Connection,
    cancellation: GenerationHistorySnapshotCancellation,
    capacity: Arc<CapacityBudget>,
    attempts: BTreeMap<String, std::result::Result<GenerationHistoryAttempt, String>>,
    messages: BTreeMap<String, std::result::Result<GenerationHistoryMessage, String>>,
    terminals: BTreeMap<String, std::result::Result<Option<StoredTerminal>, String>>,
    artifacts: BTreeMap<(String, String), std::result::Result<GenerationHistoryArtifact, String>>,
    /// HC-1 reads (`history_reads`): one enumeration, capture row and
    /// ordinal-0 index per key for the whole snapshot, so a repeated call is
    /// never charged to the turn ledger again.
    enumerations: history_reads::EnumerationCache,
    captures: history_reads::CaptureCache,
    ordinal_zero: history_reads::OrdinalZeroCache,
}

impl<'connection> GenerationHistorySnapshotReader<'connection> {
    fn new(
        connection: &'connection Connection,
        cancellation: GenerationHistorySnapshotCancellation,
        capacity: Arc<CapacityBudget>,
    ) -> Self {
        Self {
            connection,
            cancellation,
            capacity,
            attempts: BTreeMap::new(),
            messages: BTreeMap::new(),
            terminals: BTreeMap::new(),
            artifacts: BTreeMap::new(),
            enumerations: BTreeMap::new(),
            captures: BTreeMap::new(),
            ordinal_zero: BTreeMap::new(),
        }
    }

    /// Observe the owner stop/deadline and prove that this turn's exact SQL
    /// capacity scope is still installed on the connection.
    pub(crate) fn checkpoint(&self) -> Result<()> {
        self.cancellation.checkpoint()?;
        check_active_capacity(self.connection, &self.capacity)
    }

    fn restore<T>(value: std::result::Result<T, String>) -> Result<T> {
        value.map_err(|message| anyhow::anyhow!(message))
    }

    /// Read one attempt at most once for this snapshot. Reference limits are
    /// consumed cumulatively across every attempt read through this reader.
    /// The caller passes the same turn ledger used by history traversal.
    pub(crate) fn read_attempt(
        &mut self,
        budget: &mut GenerationHistoryReadBudget,
        id: &str,
    ) -> Result<GenerationHistoryAttempt> {
        identity(id)?;
        self.checkpoint()?;
        if let Some(cached) = self.attempts.get(id) {
            return Self::restore(cached.clone());
        }
        let value = match (|| {
            budget.consume_attempt()?;
            let mut references = budget.child_reference_budget();
            let mut reserve = |bytes| budget.reserve_body_bytes(bytes);
            let value = read_attempt_in_tx_with_remaining_and_reserve(
                self.connection,
                id,
                &mut references,
                &mut reserve,
                Some(&self.cancellation),
                true,
            );
            budget.apply_child_reference_budget(references);
            let value = value?;
            self.checkpoint()?;
            // A gated or excluded attempt returns before its terminal is read,
            // so `terminal: None` is not the stored terminal and is not cached.
            if let GenerationHistoryAttempt::Stored(stored) = &value {
                if stored.history_gate().is_none() {
                    self.terminals
                        .insert(id.to_owned(), Ok(stored.terminal.clone()));
                }
            }
            Ok(value)
        })() {
            Ok(value) => value,
            Err(error) => {
                self.checkpoint()?;
                if is_confirmed_missing_attempt(&error) {
                    // A missing row is stable for this read transaction and
                    // is safe to negative-cache.  Keep typed cancellation,
                    // SQLite failures, budget exhaustion, and malformed rows
                    // uncached so a later call never turns them into a stale
                    // generic marker.
                    self.attempts
                        .insert(id.to_owned(), Err(ATTEMPT_MISSING_ERROR.to_owned()));
                }
                return Err(error);
            }
        };
        self.checkpoint()?;
        self.attempts.insert(id.to_owned(), Ok(value.clone()));
        Ok(value)
    }

    /// Read an authenticated message version and its current chat body from
    /// this snapshot. The scalar body admission occurs before the canonical
    /// version reader materializes content or metadata.
    pub(crate) fn read_message(
        &mut self,
        budget: &mut GenerationHistoryReadBudget,
        id: &str,
    ) -> Result<GenerationHistoryMessage> {
        identity(id)?;
        self.checkpoint()?;
        if let Some(cached) = self.messages.get(id) {
            return Self::restore(cached.clone());
        }
        let value = match (|| {
            // The version row can be imported independently of the chat row.
            // Read only scalar lengths before fetching any identifier String;
            // otherwise a malformed message_id/project_id/session_id can
            // allocate before the canonical version reader's guard runs.
            let identifier_lengths: (i64, i64, i64) = self
                .connection
                .query_row(
                    "SELECT octet_length(message_id),octet_length(project_id),
                            octet_length(session_id)
                     FROM nir1_generation_message_versions
                     WHERE id=?1 AND invalidated=0",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .context("NIR1_GENERATION_MESSAGE_VERSION_MISSING")?;
            let identifier_lengths = [
                bounded_sqlite_length(
                    identifier_lengths.0,
                    MAX_ID_BYTES,
                    "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
                )?,
                bounded_sqlite_length(
                    identifier_lengths.1,
                    MAX_ID_BYTES,
                    "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
                )?,
                bounded_sqlite_length(
                    identifier_lengths.2,
                    MAX_ID_BYTES,
                    "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
                )?,
            ];
            let (message, project, session): (String, String, String) = self.connection.query_row(
                "SELECT message_id,project_id,session_id
                     FROM nir1_generation_message_versions
                     WHERE id=?1 AND invalidated=0",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            ensure!(
                message.len() == identifier_lengths[0]
                    && project.len() == identifier_lengths[1]
                    && session.len() == identifier_lengths[2],
                "NIR1_GENERATION_MESSAGE_VERSION_CHANGED"
            );
            self.checkpoint()?;
            let lengths =
                message_body_lengths_in_tx(self.connection, &message, &project, &session)?;
            budget.reserve_body_bytes(message_version_materialization_bytes_in_tx(
                self.connection,
                id,
            )?)?;
            self.checkpoint()?;
            let version = read_message_version_in_tx_with_cancellation(
                self.connection,
                id,
                Some(&self.cancellation),
            )?;
            let (chat_role, content, metadata, created_at) =
                read_message_body_after_preflight_in_tx(
                    self.connection,
                    &message,
                    &project,
                    &session,
                    lengths,
                    Some(&self.cancellation),
                )?;
            self.checkpoint()?;
            Ok(GenerationHistoryMessage {
                version,
                chat_role,
                content,
                metadata,
                created_at,
            })
        })() {
            Ok(value) => value,
            Err(error) => {
                self.checkpoint()?;
                return Err(error);
            }
        };
        self.checkpoint()?;
        self.messages.insert(id.to_owned(), Ok(value.clone()));
        Ok(value)
    }

    /// Return the durable terminal already read with an attempt, or read it
    /// once from the same snapshot. No write or claim path is reachable here.
    pub(crate) fn read_terminal(
        &mut self,
        budget: &mut GenerationHistoryReadBudget,
        id: &str,
    ) -> Result<Option<StoredTerminal>> {
        identity(id)?;
        self.checkpoint()?;
        if let Some(cached) = self.terminals.get(id) {
            return Self::restore(cached.clone());
        }
        let value = match (|| {
            budget.consume_attempt()?;
            let mut reserve = |bytes| budget.reserve_body_bytes(bytes);
            read_terminal_in_tx_with_reserve(
                self.connection,
                id,
                &mut reserve,
                true,
                Some(&self.cancellation),
            )
        })() {
            Ok(value) => value,
            Err(error) => {
                self.checkpoint()?;
                if is_confirmed_missing_attempt(&error) {
                    // A missing row is stable for this read transaction and
                    // is safe to negative-cache. Keep typed cancellation,
                    // SQLite failures, budget exhaustion, and malformed rows
                    // uncached so a later call never turns them into a stale
                    // generic marker.
                    self.terminals
                        .insert(id.to_owned(), Err(ATTEMPT_MISSING_ERROR.to_owned()));
                }
                return Err(error);
            }
        };
        self.checkpoint()?;
        self.terminals.insert(id.to_owned(), Ok(value.clone()));
        Ok(value)
    }

    /// Read the existing artifact identity and digest. The current schema has
    /// no immutable NIR generation producer/receipt relation, so those fields
    /// are deliberately `None`; history code must exclude this lineage.
    pub(crate) fn read_artifact(
        &mut self,
        _budget: &mut GenerationHistoryReadBudget,
        project: &str,
        artifact_id: &str,
        expected_payload_digest: &str,
    ) -> Result<GenerationHistoryArtifact> {
        identity(project)?;
        identity(artifact_id)?;
        digest(expected_payload_digest)?;
        self.checkpoint()?;
        let key = (project.to_owned(), artifact_id.to_owned());
        if let Some(cached) = self.artifacts.get(&key) {
            let value = Self::restore(cached.clone())?;
            ensure!(
                value.payload_digest == expected_payload_digest,
                "NIR1_GENERATION_ARTIFACT_MISMATCH"
            );
            return Ok(value);
        }
        let value = match (|| {
            let lengths: (i64, i64, Option<i64>) = self
                .connection
                .query_row(
                    "SELECT octet_length(a.id),octet_length(r.project_id),
                            octet_length(a.payload_digest)
                     FROM narrative_extraction_artifacts a
                     JOIN narrative_extraction_runs r ON r.id=a.run_id
                     WHERE a.id=?1 AND r.project_id=?2",
                    params![artifact_id, project],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .context("NIR1_GENERATION_ARTIFACT_MISSING")?;
            bounded_sqlite_length(lengths.0, MAX_ID_BYTES, "NIR1_GENERATION_ARTIFACT_LIMIT")?;
            bounded_sqlite_length(lengths.1, MAX_ID_BYTES, "NIR1_GENERATION_ARTIFACT_LIMIT")?;
            let payload_length = lengths.2.context("NIR1_GENERATION_ARTIFACT_MISMATCH")?;
            bounded_sqlite_length(
                payload_length,
                MAX_DIGEST_BYTES,
                "NIR1_GENERATION_ARTIFACT_DIGEST_LIMIT",
            )?;
            let (artifact_id, project_id, payload_digest): (String, String, String) =
                self.connection.query_row(
                    "SELECT a.id,r.project_id,a.payload_digest
                     FROM narrative_extraction_artifacts a
                     JOIN narrative_extraction_runs r ON r.id=a.run_id
                     WHERE a.id=?1 AND r.project_id=?2",
                    params![artifact_id, project],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            ensure!(
                artifact_id.len() <= MAX_ID_BYTES
                    && project_id.len() <= MAX_ID_BYTES
                    && payload_digest.len() == usize::try_from(payload_length)?,
                "NIR1_GENERATION_ARTIFACT_CHANGED"
            );
            self.checkpoint()?;
            digest(&payload_digest)?;
            ensure!(
                payload_digest == expected_payload_digest,
                "NIR1_GENERATION_ARTIFACT_MISMATCH"
            );
            Ok(GenerationHistoryArtifact {
                artifact_id,
                project_id,
                payload_digest,
                producer_attempt_id: None,
                producer_receipt_digest: None,
            })
        })() {
            Ok(value) => value,
            Err(error) => {
                self.checkpoint()?;
                return Err(error);
            }
        };
        self.checkpoint()?;
        self.artifacts.insert(key, Ok(value.clone()));
        Ok(value)
    }
}

/// The history snapshot's owner view for the capacity scope. `with_capacity_scope`
/// consults only `check` (at scope entry/exit and result assembly); it does not
/// install `stop_signal`/`progress_deadline` as a SQLite hook. Statement-level
/// interruption comes from the participant hook on the direct path, or from the
/// outer scope owner when a caller uses the `_in_tx` variant.
struct GenerationHistorySqlWorkControl<'a> {
    cancellation: &'a GenerationHistorySnapshotCancellation,
}

impl GraphWorkControl for GenerationHistorySqlWorkControl<'_> {
    fn check(&mut self, _stage: GraphWorkStage) -> Result<()> {
        self.cancellation.checkpoint()
    }

    fn stop_signal(&self) -> Option<Arc<AtomicBool>> {
        Some(Arc::clone(&self.cancellation.stop))
    }

    fn progress_deadline(&self) -> Option<Instant> {
        self.cancellation.deadline
    }
}

/// Keep one participant-owned read transaction open until the callback
/// returns. The callback receives only the typed reader and an owned
/// cancellation view, so it cannot open a nested transaction, mutate the
/// database, claim an attempt, or dispatch transport. Its result must be
/// owned because the higher-ranked callback lifetime cannot escape.
///
/// The caller's turn SQL ledger is admitted before the participant mutex or
/// any SQL. The bounded transaction applies its busy wait and deadline,
/// restores the prior busy timeout, and rolls back on interrupt.
pub(crate) fn with_generation_history_snapshot<T, F>(
    workspace: &ActiveWorkspaceSnapshot,
    control: ParticipantSqlControl,
    caller_budget: &mut GenerationHistoryReadBudget,
    read_snapshot: F,
) -> Result<T>
where
    F: for<'connection> FnOnce(
        &mut GenerationHistorySnapshotReader<'connection>,
        &mut GenerationHistoryReadBudget,
        &GenerationHistorySnapshotCancellation,
    ) -> Result<T>,
{
    let owner_cancellation = GenerationHistorySnapshotCancellation::from_control(&control);
    let admitted = caller_budget.admit_sql(&owner_cancellation)?;
    let cancellation = GenerationHistorySnapshotCancellation {
        stop: Arc::clone(&control.stop),
        deadline: Some(admitted.deadline),
    };
    let operation_budget = ParticipantSqlOperationBudget::new(
        Arc::clone(&control.stop),
        admitted.deadline,
        admitted.busy_wait,
    );
    workspace.db().with_participant_read_transaction_bounded(
        workspace.participant(),
        operation_budget,
        move |connection| {
            with_generation_history_snapshot_in_tx(
                connection,
                &cancellation,
                caller_budget,
                |reader, budget| read_snapshot(reader, budget, &cancellation),
            )
        },
    )
}

/// Run a typed snapshot reader on an already-owned transaction. This helper
/// never acquires the Database mutex or owns the transaction. It installs the
/// caller's exact turn capacity budget for the callback and restores the prior
/// progress owner afterwards; its caller must own the outer participant scope.
pub(crate) fn with_generation_history_snapshot_in_tx<T, F>(
    connection: &Connection,
    cancellation: &GenerationHistorySnapshotCancellation,
    caller_budget: &mut GenerationHistoryReadBudget,
    read_snapshot: F,
) -> Result<T>
where
    F: for<'connection> FnOnce(
        &mut GenerationHistorySnapshotReader<'connection>,
        &mut GenerationHistoryReadBudget,
    ) -> Result<T>,
{
    let admitted = caller_budget.admit_sql(cancellation)?;
    let cancellation = GenerationHistorySnapshotCancellation {
        stop: Arc::clone(&cancellation.stop),
        deadline: Some(admitted.deadline),
    };
    let mut owner = GenerationHistorySqlWorkControl {
        cancellation: &cancellation,
    };
    with_capacity_scope(
        connection,
        Some(Arc::clone(&admitted.capacity)),
        &mut owner,
        |capacity, _| {
            let mut reader = GenerationHistorySnapshotReader::new(
                connection,
                cancellation.clone(),
                Arc::clone(capacity),
            );
            reader.checkpoint()?;
            let value = read_snapshot(&mut reader, caller_budget)?;
            reader.checkpoint()?;
            Ok(value)
        },
    )
}

/// Unbounded test-support CAS (a stand-in for another claimer). Production
/// claims use [`claim_attempt_bounded`], which runs COMMIT without any Core,
/// profile or participant guard held.
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub fn claim_attempt(
    db: &Database,
    id: &str,
    binding: &AttemptBinding,
    now_ms: i64,
    budget: ReadBudget,
) -> Result<bool> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let attempt = read_attempt_in_tx(conn, id, budget)?;
            ensure!(
                &attempt.binding == binding,
                "NIR1_GENERATION_BINDING_MISMATCH"
            );
            ensure!(
                attempt.reference_format == ReferenceFormat::V2,
                "{}",
                REFERENCE_LEGACY_TERMINAL_ONLY_ERROR
            );
            ensure!(
                now_ms >= attempt.created_at_ms && now_ms < attempt.expires_at_ms,
                "NIR1_GENERATION_EXPIRED"
            );
            require_bound_session_and_scene(conn, binding)?;
            validate_refs(
                conn,
                binding,
                &attempt.inputs,
                &attempt.qualifications,
                budget,
            )?;
            Ok(conn.execute(
                "UPDATE nir1_generation_attempts SET claimed_at_ms=?2
                    WHERE id=?1 AND claimed_at_ms IS NULL AND terminal_json IS NULL",
                params![id, now_ms],
            )? == 1)
        })
    })
}

fn message_digest_in_tx(
    conn: &Connection,
    message: &str,
    project: &str,
    session: &str,
    reserve_before_body: impl FnOnce(usize) -> Result<()>,
) -> Result<(String, String, String)> {
    let lengths: (i64, i64, Option<i64>, i64) = conn
        .query_row(
            "SELECT octet_length(m.role),octet_length(m.content),
             octet_length(m.metadata),octet_length(m.created_at)
             FROM chat_messages m
             JOIN chat_sessions s ON s.id=m.session_id
             WHERE m.id=?1 AND m.session_id=?2 AND s.project_id=?3",
            params![message, session, project],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?
        .context("NIR1_GENERATION_MESSAGE_MISSING")?;
    bounded_sqlite_length(
        lengths.0,
        MAX_SHORT_TEXT_BYTES,
        "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
    )?;
    bounded_sqlite_length(
        lengths.1,
        MAX_MESSAGE_BODY_BYTES,
        "NIR1_GENERATION_MESSAGE_BODY_LIMIT",
    )?;
    bounded_optional_sqlite_length(
        lengths.2,
        MAX_MESSAGE_METADATA_BYTES,
        "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
    )?;
    bounded_sqlite_length(
        lengths.3,
        MAX_SHORT_TEXT_BYTES,
        "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
    )?;
    reserve_before_body(lengths.1 as usize)?;
    let (role, content, metadata, created_at): (String, String, Option<String>, String) = conn
        .query_row(
            "SELECT m.role,m.content,m.metadata,m.created_at FROM chat_messages m
             JOIN chat_sessions s ON s.id=m.session_id
             WHERE m.id=?1 AND m.session_id=?2 AND s.project_id=?3",
            params![message, session, project],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    let metadata = metadata
        .map(|value| serde_json::from_str::<Value>(&value))
        .transpose()?;
    let thinking = metadata
        .as_ref()
        .and_then(|value| value.get("thinking_blocks"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok((
        canonical_json_digest(
            &json!({"domain":"nir1-message-version@1","messageId":message,
            "projectId":project,"sessionId":session,"role":&role,"content":content,
            "thinkingBlocks":thinking,"createdAt":created_at}),
        )?,
        role,
        content,
    ))
}

fn read_message_version_in_tx(conn: &Connection, id: &str) -> Result<MessageVersion> {
    read_message_version_in_tx_with_cancellation(conn, id, None)
}

fn read_message_version_in_tx_with_cancellation(
    conn: &Connection,
    id: &str,
    cancellation: Option<&GenerationHistorySnapshotCancellation>,
) -> Result<MessageVersion> {
    read_message_version_in_tx_with_body_and_reservation(
        conn,
        id,
        cancellation,
        |_, _, _, _| Ok(()),
    )
    .map(|(version, _)| version)
}

fn read_message_version_in_tx_with_body_and_reservation(
    conn: &Connection,
    id: &str,
    cancellation: Option<&GenerationHistorySnapshotCancellation>,
    reserve_before_body: impl FnOnce(&str, &str, &str, usize) -> Result<()>,
) -> Result<(MessageVersion, String)> {
    identity(id)?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let lengths: (i64, i64, i64, i64, i64, Option<i64>, i64) = conn
        .query_row(
            "SELECT octet_length(project_id),octet_length(session_id),octet_length(message_id),
        octet_length(origin),octet_length(body_digest),octet_length(parent_attempt_id),
        created_at_ms FROM nir1_generation_message_versions WHERE id=?1 AND invalidated=0",
            [id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()?
        .context("NIR1_GENERATION_MESSAGE_VERSION_MISSING")?;
    for length in [lengths.0, lengths.1, lengths.2] {
        bounded_sqlite_length(
            length,
            MAX_ID_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?;
    }
    bounded_sqlite_length(
        lengths.3,
        MAX_SHORT_TEXT_BYTES,
        "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
    )?;
    bounded_sqlite_length(lengths.4, MAX_DIGEST_BYTES, "NIR1_GENERATION_DIGEST_LIMIT")?;
    bounded_optional_sqlite_length(
        lengths.5,
        MAX_ID_BYTES,
        "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
    )?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let row: (String, String, String, String, String, Option<String>) = conn.query_row(
        "SELECT project_id,session_id,message_id,origin,body_digest,parent_attempt_id
         FROM nir1_generation_message_versions WHERE id=?1 AND invalidated=0",
        [id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        },
    )?;
    let origin = match row.3.as_str() {
        "human" => MessageOrigin::Human,
        "generated" => MessageOrigin::Generated,
        _ => anyhow::bail!("NIR1_GENERATION_MESSAGE_ORIGIN_INVALID"),
    };
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let (body_digest, role, content) =
        message_digest_in_tx(conn, &row.2, &row.0, &row.1, |length| {
            reserve_before_body(&row.0, &row.1, &row.2, length)
        })?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let expected_role = match origin {
        MessageOrigin::Human => "user",
        MessageOrigin::Generated => "assistant",
    };
    ensure!(
        role == expected_role,
        "NIR1_GENERATION_MESSAGE_ROLE_MISMATCH"
    );
    ensure!(
        body_digest == row.4,
        "NIR1_GENERATION_MESSAGE_BODY_MISMATCH"
    );
    Ok((
        MessageVersion {
            id: id.to_owned(),
            project_id: row.0,
            session_id: row.1,
            message_id: row.2,
            origin,
            body_digest: row.4,
            parent_attempt_id: row.5,
            created_at_ms: lengths.6,
        },
        content,
    ))
}

/// Re-read the exact immutable Human message version inside its caller-owned
/// transaction, reserving its bounded body size before materializing content.
pub fn read_captured_human_message_in_tx(
    conn: &Connection,
    version_id: &str,
    expected_session_id: &str,
    reserve_before_body: impl FnOnce(usize, usize) -> Result<()>,
) -> Result<(MessageVersion, String)> {
    identity(version_id)?;
    identity(expected_session_id)?;
    let (version, content) = read_message_version_in_tx_with_body_and_reservation(
        conn,
        version_id,
        None,
        |_, session_id, _, body_bytes| {
            ensure!(
                session_id == expected_session_id,
                "NIR1_GENERATION_MESSAGE_SESSION_MISMATCH"
            );
            reserve_before_body(version_id.len(), body_bytes)
        },
    )?;
    ensure!(
        version.session_id == expected_session_id
            && version.origin == MessageOrigin::Human
            && version.parent_attempt_id.is_none(),
        "NIR1_GENERATION_HUMAN_MESSAGE_REQUIRED"
    );
    ensure!(
        !content.trim().is_empty(),
        "NIR1_GENERATION_HUMAN_MESSAGE_EMPTY"
    );
    Ok((version, content))
}

pub fn read_message_version(db: &Database, id: &str) -> Result<MessageVersion> {
    db.with_read_transaction(|conn| read_message_version_in_tx(conn, id))
}

fn bind_message_in_tx(
    conn: &Connection,
    project: &str,
    session: &str,
    message: &str,
    parent: Option<&str>,
    now_ms: i64,
) -> Result<MessageVersion> {
    let (body_digest, role, _) = message_digest_in_tx(conn, message, project, session, |_| Ok(()))?;
    let expected_role = if parent.is_some() {
        "assistant"
    } else {
        "user"
    };
    ensure!(
        role == expected_role,
        "NIR1_GENERATION_MESSAGE_ROLE_MISMATCH"
    );
    let existing_length: Option<i64> = conn
        .query_row(
            "SELECT octet_length(id) FROM nir1_generation_message_versions WHERE message_id=?1",
            [message],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing_length) = existing_length {
        bounded_sqlite_length(
            existing_length,
            MAX_ID_BYTES,
            "NIR1_GENERATION_MESSAGE_VERSION_LIMIT",
        )?;
        let id: String = conn.query_row(
            "SELECT id FROM nir1_generation_message_versions WHERE message_id=?1",
            [message],
            |row| row.get(0),
        )?;
        let existing = read_message_version_in_tx(conn, &id)?;
        ensure!(
            existing.project_id == project
                && existing.session_id == session
                && existing.parent_attempt_id.as_deref() == parent,
            "NIR1_GENERATION_MESSAGE_VERSION_CONFLICT"
        );
        return Ok(existing);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO nir1_generation_message_versions
        (id,project_id,session_id,message_id,origin,body_digest,parent_attempt_id,created_at_ms)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            id,
            project,
            session,
            message,
            if parent.is_some() {
                "generated"
            } else {
                "human"
            },
            body_digest,
            parent,
            now_ms
        ],
    )?;
    read_message_version_in_tx(conn, &id)
}

/// Called for an explicitly captured current human input, not for promoting an
/// arbitrary legacy history row. Native owns that origin decision.
pub fn bind_human_message(
    db: &Database,
    project: &str,
    session: &str,
    message: &str,
    now_ms: i64,
) -> Result<MessageVersion> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let role_length: Option<i64> = conn
                .query_row(
                    "SELECT octet_length(role) FROM chat_messages WHERE id=?1",
                    [message],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(role_length) = role_length else {
                anyhow::bail!("NIR1_GENERATION_HUMAN_ROLE_REQUIRED");
            };
            bounded_sqlite_length(
                role_length,
                MAX_SHORT_TEXT_BYTES,
                "NIR1_GENERATION_MESSAGE_METADATA_LIMIT",
            )?;
            let role: String = conn.query_row(
                "SELECT role FROM chat_messages WHERE id=?1",
                [message],
                |row| row.get(0),
            )?;
            ensure!(role == "user", "NIR1_GENERATION_HUMAN_ROLE_REQUIRED");
            bind_message_in_tx(conn, project, session, message, None, now_ms)
        })
    })
}

#[cfg(feature = "native-current-human-capture")]
fn bind_new_human_message_in_tx(
    conn: &Connection,
    project: &str,
    session: &str,
    message: &str,
    now_ms: i64,
) -> Result<MessageVersion> {
    let (body_digest, role, _) = message_digest_in_tx(conn, message, project, session, |_| Ok(()))?;
    ensure!(role == "user", "NIR1_GENERATION_HUMAN_ROLE_REQUIRED");
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO nir1_generation_message_versions
        (id,project_id,session_id,message_id,origin,body_digest,parent_attempt_id,created_at_ms)
        VALUES (?1,?2,?3,?4,'human',?5,NULL,?6)",
        params![id, project, session, message, body_digest, now_ms],
    )?;
    read_message_version_in_tx(conn, &id)
}

#[cfg(feature = "native-current-human-capture")]
fn chat_session_scene_in_tx(conn: &Connection, session: &str) -> Result<(String, String)> {
    let scope: Option<(
        i64,
        Option<i64>,
        Option<i64>,
        String,
        Option<String>,
        Option<String>,
    )> = conn
        .query_row(
            "SELECT octet_length(s.project_id),octet_length(s.node_id),
                    octet_length(n.node_type),s.project_id,s.node_id,n.node_type
               FROM chat_sessions AS s
               LEFT JOIN tree_nodes AS n
                 ON n.id=s.node_id AND n.project_id=s.project_id
              WHERE s.id=?1",
            [session],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    let (project_len, scene_len, node_type_len, project_id, scene_id, node_type) =
        scope.context("NIR1_CHAT_CAPTURE_SESSION_MISSING")?;
    bounded_sqlite_length(project_len, MAX_ID_BYTES, "NIR1_CHAT_CAPTURE_SCOPE_LIMIT")?;
    bounded_optional_sqlite_length(scene_len, MAX_ID_BYTES, "NIR1_CHAT_CAPTURE_SCOPE_LIMIT")?;
    bounded_optional_sqlite_length(
        node_type_len,
        MAX_SHORT_TEXT_BYTES,
        "NIR1_CHAT_CAPTURE_SCOPE_LIMIT",
    )?;
    identity(&project_id)?;
    let scene_id = scene_id.context("NIR1_CHAT_CAPTURE_SCENE_REQUIRED")?;
    identity(&scene_id)?;
    ensure!(
        node_type.as_deref() == Some("scene"),
        "NIR1_CHAT_CAPTURE_SCENE_REQUIRED"
    );
    Ok((project_id, scene_id))
}

#[cfg(feature = "native-current-human-capture")]
fn capture_owner_json(owner: &ChatInputCaptureOwner) -> Result<String> {
    owner.validate()?;
    Ok(canonical_json_string(&serde_json::to_value(owner)?)?)
}

#[cfg(feature = "native-current-human-capture")]
fn capture_submission_digest(
    owner: &ChatInputCaptureOwner,
    submission: &NewChatInputSubmission,
) -> Result<String> {
    Ok(canonical_json_digest(&json!({
        "domain":"nir1-current-human-chat-input@1",
        "owner":owner,
        "submissionId":submission.submission_id,
        "messageId":submission.message_id,
        "chatSessionId":submission.chat_session_id,
        "sceneId":submission.scene_id,
        "content":submission.content,
        "createdAt":submission.created_at,
    }))?)
}

#[cfg(feature = "native-current-human-capture")]
fn accepted_capture(
    capture_id: String,
    project_id: String,
    submission: &NewChatInputSubmission,
    submission_digest: String,
    message_version_id: String,
    owner: &ChatInputCaptureOwner,
) -> AcceptedChatInputCapture {
    AcceptedChatInputCapture {
        capture_id,
        project_id,
        chat_session_id: submission.chat_session_id.clone(),
        scene_id: submission.scene_id.clone(),
        submission_id: submission.submission_id.clone(),
        submission_digest,
        message_id: submission.message_id.clone(),
        message_version_id,
        owner: owner.clone(),
    }
}

#[cfg(feature = "native-current-human-capture")]
fn read_capture_row_in_tx(
    conn: &Connection,
    capture_id: &str,
) -> Result<(
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
)> {
    identity(capture_id)?;
    let lengths: Option<(i64, i64, i64, i64, i64, i64, i64, i64, i64)> = conn
        .query_row(
            "SELECT octet_length(project_id),octet_length(chat_session_id),
                    octet_length(scene_id),octet_length(submission_id),
                    octet_length(submission_digest),octet_length(message_id),
                    octet_length(message_version_id),octet_length(owner_json),octet_length(state)
               FROM nir1_chat_input_captures WHERE capture_id=?1",
            [capture_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .optional()?;
    let lengths = lengths.context("NIR1_CHAT_CAPTURE_MISSING")?;
    for (length, limit) in [
        (lengths.0, MAX_ID_BYTES),
        (lengths.1, MAX_ID_BYTES),
        (lengths.2, MAX_ID_BYTES),
        (lengths.3, MAX_ID_BYTES),
        (lengths.4, MAX_DIGEST_BYTES),
        (lengths.5, MAX_ID_BYTES),
        (lengths.6, MAX_ID_BYTES),
        (lengths.7, MAX_BINDING_JSON_BYTES),
        (lengths.8, MAX_SHORT_TEXT_BYTES),
    ] {
        bounded_sqlite_length(length, limit, "NIR1_CHAT_CAPTURE_METADATA_LIMIT")?;
    }
    conn.query_row(
        "SELECT project_id,chat_session_id,scene_id,submission_id,submission_digest,
                message_id,message_version_id,owner_json,state,created_at_ms
           FROM nir1_chat_input_captures WHERE capture_id=?1",
        [capture_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
            ))
        },
    )
    .context("NIR1_CHAT_CAPTURE_MISSING")
}

#[cfg(feature = "native-current-human-capture")]
fn read_current_chat_input_capture_and_human_in_tx(
    conn: &Connection,
    capture: &AcceptedChatInputCapture,
    expected_owner: &ChatInputCaptureOwner,
    reserve_before_body: impl FnOnce(usize, usize) -> Result<()>,
) -> Result<(MessageVersion, String)> {
    ensure!(
        &capture.owner == expected_owner,
        "NIR1_CHAT_CAPTURE_OWNER_MISMATCH"
    );
    let owner_json = capture_owner_json(expected_owner)?;
    let row = read_capture_row_in_tx(conn, &capture.capture_id)?;
    ensure!(
        row.0 == capture.project_id
            && row.1 == capture.chat_session_id
            && row.2 == capture.scene_id
            && row.3 == capture.submission_id
            && row.4 == capture.submission_digest
            && row.5 == capture.message_id
            && row.6 == capture.message_version_id
            && row.7 == owner_json
            && row.8 == "current",
        "NIR1_CHAT_CAPTURE_NOT_CURRENT"
    );
    let (project_id, scene_id) = chat_session_scene_in_tx(conn, &capture.chat_session_id)?;
    ensure!(
        project_id == capture.project_id && scene_id == capture.scene_id,
        "NIR1_CHAT_CAPTURE_SCOPE_MISMATCH"
    );
    let (version, body) = read_captured_human_message_in_tx(
        conn,
        &capture.message_version_id,
        &capture.chat_session_id,
        reserve_before_body,
    )?;
    ensure!(
        version.project_id == capture.project_id
            && version.message_id == capture.message_id
            && version.created_at_ms == row.9,
        "NIR1_CHAT_CAPTURE_MESSAGE_MISMATCH"
    );
    Ok((version, body))
}

#[cfg(feature = "native-current-human-capture")]
pub(crate) fn read_current_chat_input_capture_in_tx(
    conn: &Connection,
    capture: &AcceptedChatInputCapture,
    expected_owner: &ChatInputCaptureOwner,
    reserve_before_body: impl FnOnce(usize, usize) -> Result<()>,
) -> Result<(MessageVersion, String)> {
    read_current_chat_input_capture_and_human_in_tx(
        conn,
        capture,
        expected_owner,
        reserve_before_body,
    )
}

#[cfg(feature = "native-current-human-capture")]
fn accept_current_chat_input_in_tx(
    conn: &Connection,
    owner: &ChatInputCaptureOwner,
    submission: &NewChatInputSubmission,
    owner_json: &str,
    submission_digest: &str,
    created_at_ms: i64,
) -> Result<AcceptedChatInputCapture> {
    // Submission IDs are global durable retry keys, not session-scoped hints.
    // Resolve them before session lookup so changing the session cannot turn a
    // replay into a fresh insert.
    if let Some((capture_id, persisted_digest)) = conn
        .query_row(
            "SELECT capture_id,submission_digest
               FROM nir1_chat_input_submission_keys WHERE submission_id=?1",
            [&submission.submission_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    {
        ensure!(
            persisted_digest == submission_digest,
            "NIR1_CHAT_CAPTURE_IDEMPOTENCY_CONFLICT"
        );
        let row = read_capture_row_in_tx(conn, &capture_id)?;
        let (project_id, scene_id) = chat_session_scene_in_tx(conn, &submission.chat_session_id)?;
        ensure!(
            row.0 == project_id
                && row.1 == submission.chat_session_id
                && row.2 == submission.scene_id
                && row.3 == submission.submission_id
                && row.4 == submission_digest
                && row.5 == submission.message_id
                && row.7 == owner_json
                && scene_id == submission.scene_id,
            "NIR1_CHAT_CAPTURE_IDEMPOTENCY_CONFLICT"
        );
        ensure!(row.8 == "current", "NIR1_CHAT_CAPTURE_NOT_CURRENT");
        let (version, body) = read_current_chat_input_capture_in_tx(
            conn,
            &accepted_capture(
                capture_id.clone(),
                project_id.clone(),
                submission,
                submission_digest.to_owned(),
                row.6.clone(),
                owner,
            ),
            owner,
            |_, _| Ok(()),
        )?;
        ensure!(
            version.created_at_ms == created_at_ms && body == submission.content,
            "NIR1_CHAT_CAPTURE_IDEMPOTENCY_CONFLICT"
        );
        return Ok(accepted_capture(
            capture_id,
            project_id,
            submission,
            submission_digest.to_owned(),
            version.id,
            owner,
        ));
    }

    let (project_id, scene_id) = chat_session_scene_in_tx(conn, &submission.chat_session_id)?;
    ensure!(
        scene_id == submission.scene_id,
        "NIR1_CHAT_CAPTURE_SCOPE_MISMATCH"
    );

    // Strict INSERT is intentional: an old row with a renderer-chosen ID must
    // never be promoted into a new accepted Human turn.
    conn.execute(
        "INSERT INTO chat_messages(id,session_id,role,content,created_at)
         VALUES (?1,?2,'user',?3,?4)",
        params![
            submission.message_id,
            submission.chat_session_id,
            submission.content,
            submission.created_at
        ],
    )?;
    let version = bind_new_human_message_in_tx(
        conn,
        &project_id,
        &submission.chat_session_id,
        &submission.message_id,
        created_at_ms,
    )?;
    conn.execute(
        "UPDATE nir1_chat_input_captures SET state='superseded'
          WHERE project_id=?1 AND chat_session_id=?2 AND state='current'",
        params![project_id, submission.chat_session_id],
    )?;
    let capture_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO nir1_chat_input_captures
         (capture_id,project_id,chat_session_id,scene_id,submission_id,submission_digest,
          message_id,message_version_id,owner_json,state,created_at_ms)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'current',?10)",
        params![
            capture_id,
            project_id,
            submission.chat_session_id,
            submission.scene_id,
            submission.submission_id,
            submission_digest,
            submission.message_id,
            version.id,
            owner_json,
            created_at_ms,
        ],
    )?;
    conn.execute(
        "INSERT INTO nir1_chat_input_submission_keys
            (submission_id,capture_id,submission_digest,created_at_ms)
         VALUES (?1,?2,?3,?4)",
        params![
            submission.submission_id,
            capture_id,
            submission_digest,
            created_at_ms
        ],
    )?;
    Ok(accepted_capture(
        capture_id,
        project_id,
        submission,
        submission_digest.to_owned(),
        version.id,
        owner,
    ))
}

/// Atomically creates a fresh user message/version and makes only that exact
/// submission the session's current capture. No event or model attempt is
/// emitted here; product admission/dispatch remains a separate Native route.
#[cfg(feature = "native-current-human-capture")]
pub fn accept_current_human_chat_input(
    workspace: &ActiveWorkspaceSnapshot,
    owner: &ChatInputCaptureOwner,
    submission: &NewChatInputSubmission,
    budget: ParticipantSqlOperationBudget,
) -> Result<AcceptedChatInputCapture> {
    let created_at_ms = submission.validate()?;
    owner.validate()?;
    ensure!(
        owner.workspace_locator.as_str() == workspace.path().to_string_lossy().as_ref()
            && owner.workspace_authority_instance == workspace.authority.identity(),
        "NIR1_CHAT_CAPTURE_OWNER_MISMATCH"
    );
    let owner_json = capture_owner_json(owner)?;
    let submission_digest = capture_submission_digest(owner, submission)?;
    let inner_budget = budget.clone();
    workspace
        .authority
        .db()
        .with_participant_immediate_transaction_bounded(workspace.participant(), budget, |conn| {
            inner_budget.check(workspace.participant())?;
            let capture = accept_current_chat_input_in_tx(
                conn,
                owner,
                submission,
                &owner_json,
                &submission_digest,
                created_at_ms,
            )?;
            inner_budget.check(workspace.participant())?;
            Ok(capture)
        })
}

/// One-way cancellation for the exact accepted owner/capture. A terminal or
/// superseded capture cannot be revived or redirected to another submission.
#[cfg(feature = "native-current-human-capture")]
pub fn cancel_current_human_chat_input(
    workspace: &ActiveWorkspaceSnapshot,
    capture: &AcceptedChatInputCapture,
    expected_owner: &ChatInputCaptureOwner,
    budget: ParticipantSqlOperationBudget,
) -> Result<()> {
    ensure!(
        &capture.owner == expected_owner
            && expected_owner.workspace_locator.as_str()
                == workspace.path().to_string_lossy().as_ref()
            && expected_owner.workspace_authority_instance == workspace.authority.identity(),
        "NIR1_CHAT_CAPTURE_OWNER_MISMATCH"
    );
    let owner_json = capture_owner_json(expected_owner)?;
    workspace
        .authority
        .db()
        .with_participant_immediate_transaction_bounded(workspace.participant(), budget, |conn| {
            read_current_chat_input_capture_in_tx(conn, capture, expected_owner, |_, _| Ok(()))?;
            let changed = conn.execute(
                "UPDATE nir1_chat_input_captures SET state='cancelled'
                  WHERE capture_id=?1 AND owner_json=?2 AND state='current'",
                params![capture.capture_id, owner_json],
            )?;
            ensure!(changed == 1, "NIR1_CHAT_CAPTURE_NOT_CURRENT");
            Ok(())
        })
}

/// Terminalize one exact durable submission by its main-authorized sender.
/// This operation can only remove currentness; it never creates a capture.
#[cfg(feature = "native-current-human-capture")]
pub fn retire_current_human_chat_input(
    workspace: &ActiveWorkspaceSnapshot,
    authorized_owner: &ChatInputCaptureOwner,
    chat_session_id: &str,
    budget: ParticipantSqlOperationBudget,
) -> Result<ChatInputCaptureRetirementOutcome> {
    identity(chat_session_id)?;
    authorized_owner.validate()?;
    ensure!(
        authorized_owner.workspace_locator.as_str() == workspace.path().to_string_lossy().as_ref()
            && authorized_owner.workspace_authority_instance == workspace.authority.identity(),
        "NIR1_CHAT_CAPTURE_OWNER_MISMATCH"
    );
    let inner_budget = budget.clone();
    workspace
        .authority
        .db()
        .with_participant_immediate_transaction_bounded(workspace.participant(), budget, |conn| {
            inner_budget.check(workspace.participant())?;
            let session: Option<(i64, i64, String)> = conn
                .query_row(
                    "SELECT octet_length(id),octet_length(project_id),project_id
                       FROM chat_sessions WHERE id=?1",
                    [chat_session_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let (session_len, project_len, project_id) =
                session.context("NIR1_CHAT_CAPTURE_SESSION_MISSING")?;
            bounded_sqlite_length(session_len, MAX_ID_BYTES, "NIR1_CHAT_CAPTURE_SCOPE_LIMIT")?;
            bounded_sqlite_length(project_len, MAX_ID_BYTES, "NIR1_CHAT_CAPTURE_SCOPE_LIMIT")?;
            identity(&project_id)?;
            let changed = conn.execute(
                "UPDATE nir1_chat_input_captures SET state='superseded'
                  WHERE project_id=?1 AND chat_session_id=?2 AND state='current'",
                params![project_id, chat_session_id],
            )?;
            ensure!(changed <= 1, "NIR1_CHAT_CAPTURE_CURRENT_INVARIANT_BROKEN");
            inner_budget.check(workspace.participant())?;
            Ok(if changed == 1 {
                ChatInputCaptureRetirementOutcome::Retired
            } else {
                ChatInputCaptureRetirementOutcome::NotCurrent
            })
        })
}

#[cfg(feature = "native-current-human-capture")]
pub fn cancel_current_human_chat_input_by_submission(
    workspace: &ActiveWorkspaceSnapshot,
    authorized_owner: &ChatInputCaptureOwner,
    submission_id: &str,
    message_id: &str,
    chat_session_id: &str,
    scene_id: &str,
    budget: ParticipantSqlOperationBudget,
) -> Result<ChatInputCaptureCancellationOutcome> {
    for value in [submission_id, message_id, chat_session_id, scene_id] {
        identity(value)?;
    }
    authorized_owner.validate()?;
    ensure!(
        authorized_owner.workspace_locator.as_str() == workspace.path().to_string_lossy().as_ref()
            && authorized_owner.workspace_authority_instance == workspace.authority.identity(),
        "NIR1_CHAT_CAPTURE_OWNER_MISMATCH"
    );
    let inner_budget = budget.clone();
    workspace
        .authority
        .db()
        .with_participant_immediate_transaction_bounded(workspace.participant(), budget, |conn| {
            inner_budget.check(workspace.participant())?;
            let key: Option<(String, String)> = conn
                .query_row(
                    "SELECT capture_id,submission_digest
                       FROM nir1_chat_input_submission_keys WHERE submission_id=?1",
                    [submission_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((capture_id, key_digest)) = key else {
                return Ok(ChatInputCaptureCancellationOutcome::NotFound);
            };
            let exists: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM nir1_chat_input_captures WHERE capture_id=?1",
                    [&capture_id],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Ok(ChatInputCaptureCancellationOutcome::NotCurrent);
            }
            let row = read_capture_row_in_tx(conn, &capture_id)?;
            ensure!(
                row.3 == submission_id
                    && row.4 == key_digest
                    && row.5 == message_id
                    && row.1 == chat_session_id
                    && row.2 == scene_id,
                "NIR1_CHAT_CAPTURE_IDEMPOTENCY_CONFLICT"
            );
            let persisted_owner: ChatInputCaptureOwner =
                serde_json::from_str(&row.7).context("NIR1_CHAT_CAPTURE_OWNER_INVALID")?;
            ensure!(
                persisted_owner.same_capture_incarnation(authorized_owner),
                "NIR1_CHAT_CAPTURE_OWNER_MISMATCH"
            );
            if row.8 != "current" {
                return Ok(ChatInputCaptureCancellationOutcome::NotCurrent);
            }
            let changed = conn.execute(
                "UPDATE nir1_chat_input_captures SET state='cancelled'
                  WHERE capture_id=?1 AND submission_id=?2 AND message_id=?3
                    AND owner_json=?4 AND state='current'",
                params![capture_id, submission_id, message_id, row.7],
            )?;
            inner_budget.check(workspace.participant())?;
            Ok(if changed == 1 {
                ChatInputCaptureCancellationOutcome::Cancelled
            } else {
                ChatInputCaptureCancellationOutcome::NotCurrent
            })
        })
}

fn receipt_digest(terminal: &StoredTerminal) -> Result<String> {
    Ok(canonical_json_digest(
        &json!({"domain":"nir1-generation-receipt@1",
        "attemptId":terminal.attempt_id,"payloadDigest":terminal.payload_digest,
        "inputDigest":terminal.input_digest,"messageVersion":terminal.message_version,
        "observation":terminal.observation,"failureClassification":terminal.failure_classification,
        "retryClassification":terminal.retry_classification,"completedAtMs":terminal.completed_at_ms}),
    )?)
}

fn read_terminal_in_tx(conn: &Connection, id: &str) -> Result<Option<StoredTerminal>> {
    let mut no_reserve = |_bytes: usize| Ok(());
    read_terminal_in_tx_with_reserve(conn, id, &mut no_reserve, true, None)
}

fn read_terminal_in_tx_with_reserve<F>(
    conn: &Connection,
    id: &str,
    reserve: &mut F,
    charge_attempt_metadata: bool,
    cancellation: Option<&GenerationHistorySnapshotCancellation>,
) -> Result<Option<StoredTerminal>>
where
    F: FnMut(usize) -> Result<()>,
{
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let lengths: Option<(Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT octet_length(terminal_json),octet_length(terminal_digest)
             FROM nir1_generation_attempts WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((json_length, digest_length)) = lengths else {
        anyhow::bail!("NIR1_GENERATION_ATTEMPT_MISSING");
    };
    match (json_length, digest_length) {
        (None, None) => return Ok(None),
        (Some(json_length), Some(digest_length)) => {
            bounded_sqlite_length(
                json_length,
                MAX_TERMINAL_JSON_BYTES,
                "NIR1_GENERATION_TERMINAL_LIMIT",
            )?;
            bounded_sqlite_length(
                digest_length,
                MAX_DIGEST_BYTES,
                "NIR1_GENERATION_DIGEST_LIMIT",
            )?;
        }
        _ => anyhow::bail!("NIR1_GENERATION_RECEIPT_MISMATCH"),
    }
    if charge_attempt_metadata {
        reserve(attempt_metadata_materialization_bytes_in_tx(conn, id)?)?;
    }
    let terminal_bytes = match (json_length, digest_length) {
        (Some(json_length), Some(digest_length)) => sum_materialization_bytes([
            bounded_sqlite_length(
                json_length,
                MAX_TERMINAL_JSON_BYTES,
                "NIR1_GENERATION_TERMINAL_LIMIT",
            )?,
            bounded_sqlite_length(
                digest_length,
                MAX_DIGEST_BYTES,
                "NIR1_GENERATION_DIGEST_LIMIT",
            )?,
        ])?,
        _ => 0,
    };
    reserve(terminal_bytes)?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let (raw, stored_digest): (String, String) = conn.query_row(
        "SELECT terminal_json,terminal_digest FROM nir1_generation_attempts WHERE id=?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    digest(&stored_digest)?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    let terminal: StoredTerminal = serde_json::from_str(&raw)?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    ensure!(
        terminal.attempt_id == id
            && terminal.receipt_digest == stored_digest
            && receipt_digest(&terminal)? == stored_digest,
        "NIR1_GENERATION_RECEIPT_MISMATCH"
    );
    let (terminal_status, parse_status) = validate_persisted_observation(&terminal.observation)?;
    validate_terminal_classification(
        terminal_status,
        parse_status,
        terminal.failure_classification.as_ref(),
        &terminal.retry_classification,
    )?;
    let attempt = read_attempt_metadata_in_tx(conn, id)?;
    if let Some(cancellation) = cancellation {
        cancellation.checkpoint()?;
    }
    // A written terminal stays readable for both binding formats.
    read_stored_binding(
        &attempt.binding_json,
        &attempt.project_id,
        &attempt.session_id,
    )?;
    ensure!(
        terminal.payload_digest == attempt.payload_digest,
        "NIR1_GENERATION_PAYLOAD_DIGEST_MISMATCH"
    );
    ensure!(
        terminal.input_digest == attempt.input_digest,
        "NIR1_GENERATION_INPUT_DIGEST_MISMATCH"
    );
    ensure!(
        (terminal_status == TerminalStatus::Succeeded) == terminal.message_version.is_some(),
        "NIR1_GENERATION_TERMINAL_BODY_MISMATCH"
    );
    if terminal_status == TerminalStatus::Succeeded {
        ensure!(
            attempt.claimed_at_ms.is_some(),
            "NIR1_GENERATION_SUCCESS_BODY_OR_CLAIM_MISSING"
        );
    }
    if let Some(version) = terminal.message_version.as_ref() {
        if let Some(cancellation) = cancellation {
            cancellation.checkpoint()?;
        }
        reserve(message_version_materialization_bytes_in_tx(
            conn,
            &version.id,
        )?)?;
        let current =
            read_message_version_in_tx_with_cancellation(conn, &version.id, cancellation)?;
        if let Some(cancellation) = cancellation {
            cancellation.checkpoint()?;
        }
        ensure!(
            current == *version
                && version.origin == MessageOrigin::Generated
                && version.project_id == attempt.project_id
                && version.session_id == attempt.session_id
                && version.parent_attempt_id.as_deref() == Some(id),
            "NIR1_GENERATION_MESSAGE_VERSION_MISMATCH"
        );
    }
    Ok(Some(terminal))
}

/// Read and authenticate one persisted receipt and its output object. A
/// generated-parent lineage check uses `read_attempt_in_tx_with_remaining`
/// instead so the parent's stored reference rows are authenticated too.
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub fn read_terminal(db: &Database, id: &str) -> Result<Option<StoredTerminal>> {
    db.with_read_transaction(|conn| read_terminal_in_tx(conn, id))
}

fn validate_observation_fields(
    digest_version: &str,
    provider_terminal: Option<ProviderTerminal>,
    terminal_status: TerminalStatus,
    parse_status: ParseStatus,
    text_digest: &str,
    thinking_digest: &str,
    response_digest: Option<&str>,
) -> Result<()> {
    validate_terminal_matrix(terminal_status, parse_status, response_digest.is_some())
        .map_err(|_| anyhow::anyhow!("NIR1_GENERATION_OBSERVATION_INVALID"))?;
    ensure!(
        digest_version == OUTPUT_DIGEST_VERSION,
        "NIR1_GENERATION_OUTPUT_VERSION_MISMATCH"
    );
    digest(text_digest)?;
    digest(thinking_digest)?;
    if let Some(value) = response_digest {
        digest(value)?;
    }
    if terminal_status == TerminalStatus::Succeeded {
        ensure!(
            provider_terminal == Some(ProviderTerminal::Complete)
                && parse_status == ParseStatus::Parsed,
            "NIR1_GENERATION_PROVIDER_TERMINAL_REQUIRED"
        );
    }
    Ok(())
}

fn validate_observation(observation: &TerminalObservation) -> Result<()> {
    validate_observation_fields(
        observation.digest_version,
        observation.provider_terminal,
        observation.terminal_status,
        observation.parse_status,
        &observation.text_digest,
        &observation.thinking_digest,
        observation.response_digest.as_deref(),
    )
}

fn validate_persisted_observation(value: &Value) -> Result<(TerminalStatus, ParseStatus)> {
    let observation: PersistedObservation =
        serde_json::from_value(value.clone()).context("NIR1_GENERATION_OBSERVATION_INVALID")?;
    validate_observation_fields(
        &observation.digest_version,
        observation.provider_terminal,
        observation.terminal_status,
        observation.parse_status,
        &observation.text_digest,
        &observation.thinking_digest,
        observation.response_digest.as_deref(),
    )?;
    Ok((observation.terminal_status, observation.parse_status))
}

fn validate_terminal_classification(
    terminal_status: TerminalStatus,
    parse_status: ParseStatus,
    failure_classification: Option<&FailureClassification>,
    retry_classification: &RetryClassification,
) -> Result<()> {
    let valid = match (terminal_status, parse_status) {
        (TerminalStatus::Succeeded, ParseStatus::Parsed) => {
            failure_classification.is_none()
                && *retry_classification == RetryClassification::NotApplicable
        }
        (TerminalStatus::Failed, ParseStatus::Invalid) => {
            failure_classification == Some(&FailureClassification::InvalidOutput)
                && *retry_classification == RetryClassification::NewAttemptRequired
        }
        (TerminalStatus::Failed, ParseStatus::NotAttempted) => {
            matches!(
                failure_classification,
                Some(FailureClassification::DispatchUnavailable)
                    | Some(FailureClassification::InterruptedUnknown)
            ) && *retry_classification == RetryClassification::NewAttemptRequired
        }
        (TerminalStatus::Cancelled, ParseStatus::NotAttempted) => {
            failure_classification == Some(&FailureClassification::Cancelled)
                && *retry_classification == RetryClassification::NewAttemptRequired
        }
        (TerminalStatus::Skipped, ParseStatus::NotAttempted) => {
            failure_classification == Some(&FailureClassification::Skipped)
                && *retry_classification == RetryClassification::NewAttemptRequired
        }
        _ => false,
    };
    ensure!(valid, "NIR1_GENERATION_TERMINAL_CLASSIFICATION_INVALID");
    Ok(())
}

fn finish_in_tx(
    conn: &Connection,
    id: &str,
    observation: &TerminalObservation,
    body: Option<&NewMessageBody>,
    now_ms: i64,
    recovery: bool,
    audit: AuditClose<'_>,
) -> Result<StoredTerminal> {
    validate_observation(observation)?;
    ensure!(
        observation.terminal_status == TerminalStatus::Succeeded || body.is_none(),
        "NIR1_GENERATION_NON_SUCCESS_BODY"
    );
    if let Some(body) = body {
        ensure!(
            body.content.len() <= MAX_MESSAGE_BODY_BYTES
                && body.thinking.len() <= MAX_MESSAGE_BODY_BYTES,
            "NIR1_GENERATION_MESSAGE_BODY_LIMIT"
        );
    }
    let stored = read_attempt_metadata_in_tx(conn, id)?;
    let binding =
        read_stored_binding(&stored.binding_json, &stored.project_id, &stored.session_id)?;
    // A legacy v1 row may only be terminalized without a body (recovery or a
    // non-success observation). A success body needs the current format.
    let success_binding = if observation.terminal_status == TerminalStatus::Succeeded {
        Some(binding.into_current()?)
    } else {
        None
    };
    // Recovery records a conservative terminalization, not a provider event.
    // A regressed wall clock must not strand the attempt or place its terminal
    // before an already-durable create/claim. Live completion keeps its strict
    // timestamp validation; operation deadlines use a monotonic clock.
    let now_ms = if recovery {
        now_ms
            .max(stored.created_at_ms)
            .max(stored.claimed_at_ms.unwrap_or(stored.created_at_ms))
    } else {
        now_ms
    };
    ensure!(
        now_ms >= stored.created_at_ms,
        "NIR1_GENERATION_TIME_MISMATCH"
    );
    ensure!(
        observation.terminal_status != TerminalStatus::Succeeded
            || (stored.claimed_at_ms.is_some() && body.is_some()),
        "NIR1_GENERATION_SUCCESS_BODY_OR_CLAIM_MISSING"
    );
    if let Some(existing) = read_terminal_in_tx(conn, id)? {
        ensure!(
            existing.observation == serde_json::to_value(observation)?
                && existing
                    .message_version
                    .as_ref()
                    .map(|v| v.message_id.as_str())
                    == body.map(|b| b.message_id.as_str()),
            "NIR1_GENERATION_TERMINAL_CONFLICT"
        );
        if let Some(version) = &existing.message_version {
            read_message_version_in_tx(conn, &version.id)?;
            if let Some(body) = body {
                verify_body_observation(body, observation)?;
            }
        }
        return Ok(existing);
    }
    let message_version = if let Some(body) = body {
        // A body implies a success observation (NIR1_GENERATION_NON_SUCCESS_BODY).
        let binding = success_binding
            .as_ref()
            .context("NIR1_GENERATION_NON_SUCCESS_BODY")?;
        identity(&body.message_id)?;
        verify_body_observation(body, observation)?;
        let metadata = if body.thinking.is_empty() {
            None
        } else {
            Some(serde_json::to_string(
                &json!({"thinking_blocks":[{"thinking":body.thinking}]}),
            )?)
        };
        if let Some(metadata) = metadata.as_ref() {
            ensure!(
                metadata.len() <= MAX_MESSAGE_METADATA_BYTES,
                "NIR1_GENERATION_MESSAGE_METADATA_LIMIT"
            );
        }
        let created = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms)
            .context("NIR1_GENERATION_TIME_MISMATCH")?
            .to_rfc3339();
        conn.execute(
            "INSERT INTO chat_messages(id,session_id,role,content,model,metadata,created_at)
            VALUES (?1,?2,'assistant',?3,?4,?5,?6)",
            params![
                body.message_id,
                &stored.session_id,
                body.content,
                &binding.model,
                metadata,
                created
            ],
        )?;
        Some(bind_message_in_tx(
            conn,
            &stored.project_id,
            &stored.session_id,
            &body.message_id,
            Some(id),
            now_ms,
        )?)
    } else {
        None
    };
    let failure_classification = if recovery {
        Some(FailureClassification::InterruptedUnknown)
    } else {
        match observation.terminal_status {
            TerminalStatus::Succeeded => None,
            TerminalStatus::Failed if observation.parse_status == ParseStatus::Invalid => {
                Some(FailureClassification::InvalidOutput)
            }
            TerminalStatus::Failed => Some(FailureClassification::DispatchUnavailable),
            TerminalStatus::Cancelled => Some(FailureClassification::Cancelled),
            TerminalStatus::Skipped => Some(FailureClassification::Skipped),
        }
    };
    let retry_classification = if failure_classification.is_some() {
        RetryClassification::NewAttemptRequired
    } else {
        RetryClassification::NotApplicable
    };
    let mut terminal = StoredTerminal {
        attempt_id: id.to_owned(),
        payload_digest: stored.payload_digest,
        input_digest: stored.input_digest,
        message_version,
        observation: serde_json::to_value(observation)?,
        failure_classification,
        retry_classification,
        completed_at_ms: now_ms,
        receipt_digest: String::new(),
    };
    terminal.receipt_digest = receipt_digest(&terminal)?;
    let terminal_json = canonical_json_string(&serde_json::to_value(&terminal)?)?;
    ensure!(
        terminal_json.len() <= MAX_TERMINAL_JSON_BYTES,
        "NIR1_GENERATION_TERMINAL_LIMIT"
    );
    ensure!(
        conn.execute(
            "UPDATE nir1_generation_attempts SET terminal_json=?2,terminal_digest=?3,
        completed_at_ms=?4,output_version_id=?5 WHERE id=?1 AND terminal_json IS NULL",
            params![
                id,
                terminal_json,
                terminal.receipt_digest,
                now_ms,
                terminal.message_version.as_ref().map(|v| v.id.as_str())
            ]
        )? == 1,
        "NIR1_GENERATION_TERMINAL_CONFLICT"
    );
    // Only a terminal this call has just written closes the started execution
    // (an identical earlier write returned above), in the same transaction.
    close_execution_in_tx(
        conn,
        &stored.project_id,
        id,
        observation,
        &terminal,
        audit,
        recovery,
    )?;
    Ok(terminal)
}

fn verify_body_observation(body: &NewMessageBody, observation: &TerminalObservation) -> Result<()> {
    let mut observer = OutputObserver::new();
    observer.observe(OutputChannel::Text, body.content.as_bytes())?;
    observer.observe(OutputChannel::Thinking, body.thinking.as_bytes())?;
    let observed = observer.finish(Completion::ParseFailure);
    ensure!(
        observed.text_digest == observation.text_digest
            && observed.thinking_digest == observation.thinking_digest,
        "NIR1_GENERATION_OUTPUT_BODY_MISMATCH"
    );
    Ok(())
}

/// Unbounded test-support terminal writer. Owners use
/// [`finish_attempt_bounded`] or [`finish_pretransport_attempt_bounded`].
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub fn finish_attempt(
    db: &Database,
    id: &str,
    observation: &TerminalObservation,
    body: Option<NewMessageBody>,
    now_ms: i64,
) -> Result<StoredTerminal> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            finish_in_tx(
                conn,
                id,
                observation,
                body.as_ref(),
                now_ms,
                false,
                AuditClose::Conservative,
            )
        })
    })
}

/// Recovery owns one exact durable unfinished attempt. It never reconstructs a
/// transport request, resumes a claim, or asserts that no bytes were sent.
/// Unbounded test-support form; the sweep uses [`recover_attempt_bounded`].
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub fn recover_attempt(db: &Database, id: &str, now_ms: i64) -> Result<StoredTerminal> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| recover_attempt_in_tx(conn, id, now_ms))
    })
}

fn recover_attempt_in_tx(conn: &Connection, id: &str, now_ms: i64) -> Result<StoredTerminal> {
    if let Some(terminal) = read_terminal_in_tx(conn, id)? {
        return Ok(terminal);
    }
    let failed = OutputObserver::new().finish(Completion::DispatchFailure);
    finish_in_tx(
        conn,
        id,
        &failed,
        None,
        now_ms,
        true,
        AuditClose::Conservative,
    )
}

/// Recover one existing attempt under the same participant-owned connection
/// scope as startup enumeration. A timeout or stop returns incomplete after
/// the scope rolls back and restores SQLite connection settings.
pub fn recover_attempt_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    id: &str,
    now_ms: i64,
    budget: ParticipantSqlOperationBudget,
) -> Result<StoredTerminal> {
    identity(id)?;
    workspace
        .authority
        .db()
        .with_participant_immediate_transaction_bounded(
            workspace.participant(),
            budget.with_connection_lock_timeout(NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT),
            |conn| recover_attempt_in_tx(conn, id, now_ms),
        )
}

/// Whether a [`recover_attempt_bounded`] error is only its connection mutex
/// wait exceeding [`NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT`] (`ConnectionBusy`).
/// No SQL ran, so the sweep may try the same exact recovery again; the
/// recovery is idempotent in any case.
pub fn is_recovery_connection_busy(error: &anyhow::Error) -> bool {
    error_chain_contains(error, NIR1_SQL_CONNECTION_LOCK_TIMEOUT)
}

// ---------------------------------------------------------------------------
// Bounded attempt create / claim / terminal writers (DT-2).
//
// Every writer below waits at most NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT for the
// process-local connection mutex, at most NIR1_GENERATION_SQLITE_BUSY_LIMIT
// for one SQLite busy wait, and at most NIR1_GENERATION_OPERATION_LIMIT from
// its start (mutex wait included). A writer that exceeds a limit returns a
// typed error; its IMMEDIATE transaction is rolled back and the connection is
// restored by the participant scope before it can be reused. COMMIT runs
// without any Core, profile or participant guard held.
// ---------------------------------------------------------------------------

/// Upper bound for waiting on the process-local Database connection mutex.
pub const NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT: Duration = Duration::from_millis(100);
/// Upper bound for one SQLite busy wait, clipped to the remaining op budget.
pub const NIR1_GENERATION_SQLITE_BUSY_LIMIT: Duration = Duration::from_millis(100);
/// Upper bound for one bounded generation operation, measured from its start
/// and including the connection mutex wait.
pub const NIR1_GENERATION_OPERATION_LIMIT: Duration = Duration::from_millis(250);
/// Per-operation limit of a budget made with `for_untimed_test`, and of the
/// Native recovery sweep in test builds: a test that does not examine the
/// per-operation limit runs under it. It exists only in test builds and with
/// the `workspace-maintenance-test-support` feature, never in a release build.
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub const NIR1_GENERATION_UNTIMED_TEST_OPERATION_LIMIT: Duration = Duration::from_secs(10);

/// True only while the caller is still inside its admission. It must read
/// atomics only: it runs from the SQLite progress hook while the connection
/// mutex is held, so it may not take any lock.
pub type Nir1AdmissionProbe = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Nir1SqlLimits {
    mutex: Duration,
    busy: Duration,
    operation: Duration,
}

impl Nir1SqlLimits {
    const DEFAULT: Self = Self {
        mutex: NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT,
        busy: NIR1_GENERATION_SQLITE_BUSY_LIMIT,
        operation: NIR1_GENERATION_OPERATION_LIMIT,
    };

    /// Tests may only tighten the plan defaults, never relax them. The one
    /// exception is a test that does not examine the per-operation limit: it
    /// widens that limit alone through `untimed_for_test`.
    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    fn tightened(mutex: Duration, busy: Duration, operation: Duration) -> Self {
        assert!(
            mutex <= Self::DEFAULT.mutex
                && busy <= Self::DEFAULT.busy
                && operation <= Self::DEFAULT.operation,
            "NIR1 generation SQL limits may only be tightened"
        );
        Self {
            mutex,
            busy,
            operation,
        }
    }

    /// The per-operation limit widened to the untimed-test limit; the mutex
    /// and busy limits are unchanged.
    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    fn untimed_for_test(self) -> Self {
        Self {
            operation: self
                .operation
                .max(NIR1_GENERATION_UNTIMED_TEST_OPERATION_LIMIT),
            ..self
        }
    }

    fn operation_budget(&self, stop: Arc<AtomicBool>) -> ParticipantSqlOperationBudget {
        ParticipantSqlOperationBudget::new(stop, Instant::now() + self.operation, self.busy)
            .with_connection_lock_timeout(self.mutex)
    }
}

/// Test-only fault injection at the COMMIT boundary of one bounded writer.
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
#[derive(Clone)]
pub enum Nir1GenerationFailpoint {
    /// COMMIT is applied, then the writer reports an ambiguous error.
    ErrorAfterCommit,
    /// A commit hook vetoes COMMIT; the writer reports an ambiguous error.
    VetoCommit,
    /// The commit hook runs this probe (connection mutex held) and commits.
    ProbeDuringCommit(Arc<dyn Fn() + Send + Sync>),
}

#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
impl fmt::Debug for Nir1GenerationFailpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ErrorAfterCommit => "ErrorAfterCommit",
            Self::VetoCommit => "VetoCommit",
            Self::ProbeDuringCommit(_) => "ProbeDuringCommit",
        })
    }
}

/// Budget for create and claim. These writers are interrupted by the owner's
/// cancel, the participant stop and a false admission probe.
#[derive(Clone)]
pub struct Nir1AdmissionSqlBudget {
    cancel: Arc<AtomicBool>,
    probe: Nir1AdmissionProbe,
    limits: Nir1SqlLimits,
    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    failpoint: Option<Nir1GenerationFailpoint>,
}

impl Nir1AdmissionSqlBudget {
    /// Plan defaults (mutex 100 ms, busy 100 ms, per-op 250 ms).
    pub fn new(cancel: Arc<AtomicBool>, probe: Nir1AdmissionProbe) -> Self {
        Self {
            cancel,
            probe,
            limits: Nir1SqlLimits::DEFAULT,
            #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
            failpoint: None,
        }
    }

    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    pub fn tightened(mut self, mutex: Duration, busy: Duration, operation: Duration) -> Self {
        self.limits = Nir1SqlLimits::tightened(mutex, busy, operation);
        self
    }

    /// For a test that does not examine the per-operation limit: widens that
    /// limit alone, to [`NIR1_GENERATION_UNTIMED_TEST_OPERATION_LIMIT`], so a
    /// loaded CI runner cannot turn an unrelated assertion into `TimedOut` by
    /// overrunning the plan's 250 ms. The mutex and busy limits stay the
    /// plan's, so a test of either still sees it end the wait. Only a test of
    /// the per-operation limit itself, or of which limit takes effect first (a
    /// mutex wait that must end before the plan's operation limit would),
    /// keeps the plan's budget and does not call this.
    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    pub fn for_untimed_test(mut self) -> Self {
        self.limits = self.limits.untimed_for_test();
        self
    }

    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    pub fn with_failpoint(mut self, failpoint: Nir1GenerationFailpoint) -> Self {
        self.failpoint = Some(failpoint);
        self
    }

    fn sql_budget(&self) -> ParticipantSqlOperationBudget {
        self.limits.operation_budget(Arc::clone(&self.cancel))
    }

    fn fence(&self) -> ParticipantSqlFence {
        ParticipantSqlFence::Admission {
            probe: Some(Arc::clone(&self.probe)),
        }
    }

    fn cancel_requested(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    fn failpoint(&self) -> WriteFailpoint {
        #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
        {
            self.failpoint.clone()
        }
        #[cfg(not(any(test, feature = "workspace-maintenance-test-support")))]
        {
            WriteFailpoint
        }
    }
}

/// Budget for an existing owner's own cleanup: the zero-send terminal, the
/// post-transport terminal and recover, and the exact reread. It carries no
/// stop and no probe, so it cannot be handed the owner's cancel by mistake;
/// the three limits alone keep it finite.
#[derive(Clone, Debug)]
pub struct Nir1PinnedSqlBudget {
    limits: Nir1SqlLimits,
    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    failpoint: Option<Nir1GenerationFailpoint>,
}

impl Default for Nir1PinnedSqlBudget {
    fn default() -> Self {
        Self::new()
    }
}

impl Nir1PinnedSqlBudget {
    /// Plan defaults (mutex 100 ms, busy 100 ms, per-op 250 ms).
    pub fn new() -> Self {
        Self {
            limits: Nir1SqlLimits::DEFAULT,
            #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
            failpoint: None,
        }
    }

    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    pub fn tightened(mut self, mutex: Duration, busy: Duration, operation: Duration) -> Self {
        self.limits = Nir1SqlLimits::tightened(mutex, busy, operation);
        self
    }

    /// For a test that does not examine the per-operation limit; see
    /// [`Nir1AdmissionSqlBudget::for_untimed_test`].
    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    pub fn for_untimed_test(mut self) -> Self {
        self.limits = self.limits.untimed_for_test();
        self
    }

    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    pub fn with_failpoint(mut self, failpoint: Nir1GenerationFailpoint) -> Self {
        self.failpoint = Some(failpoint);
        self
    }

    fn sql_budget(&self) -> ParticipantSqlOperationBudget {
        // A private flag nothing sets: a Pinned scope never observes a stop.
        self.limits
            .operation_budget(Arc::new(AtomicBool::new(false)))
    }

    fn failpoint(&self) -> WriteFailpoint {
        #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
        {
            self.failpoint.clone()
        }
        #[cfg(not(any(test, feature = "workspace-maintenance-test-support")))]
        {
            WriteFailpoint
        }
    }
}

#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
type WriteFailpoint = Option<Nir1GenerationFailpoint>;

/// Production builds carry no failpoint.
#[cfg(not(any(test, feature = "workspace-maintenance-test-support")))]
#[derive(Clone, Copy)]
struct WriteFailpoint;

/// Whether a bounded writer's COMMIT may have been applied.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Nir1CommitState {
    /// Failed before the transaction was ready to commit; nothing is durable.
    NotCommitted,
    /// Failed at or after COMMIT; the caller must reread the exact row.
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum Nir1StoreFailure {
    /// The connection mutex wait exceeded its limit.
    ConnectionBusy,
    /// SQLite reported BUSY/LOCKED after its busy limit.
    SqliteBusy,
    /// The per-operation limit elapsed.
    TimedOut,
    /// The participant stopped or the admission probe turned false.
    Fenced,
    /// The owner's cancel was observed.
    Cancelled,
    /// The connection is quarantined or its cleanup was not proven.
    ConnectionUnavailable,
    /// A participant SQL or capacity owner is already active on this thread.
    SqlOwnerActive,
    /// The deterministic attempt identity is already durable.
    AlreadyExists,
    /// The stored immutable fields differ from the expected ones.
    Conflict,
    /// A different terminal is already durable.
    TerminalConflict,
    /// The stored claim state differs from the one the writer expected.
    ClaimMismatch,
    Expired,
    /// The capture or workspace binding is no longer current.
    NotCurrent,
    Missing,
    Invalid,
}

impl Nir1StoreFailure {
    fn code(self) -> &'static str {
        match self {
            Self::ConnectionBusy => "connection-busy",
            Self::SqliteBusy => "sqlite-busy",
            Self::TimedOut => "timed-out",
            Self::Fenced => "fenced",
            Self::Cancelled => "cancelled",
            Self::ConnectionUnavailable => "connection-unavailable",
            Self::SqlOwnerActive => "sql-owner-active",
            Self::AlreadyExists => "already-exists",
            Self::Conflict => "conflict",
            Self::TerminalConflict => "terminal-conflict",
            Self::ClaimMismatch => "claim-mismatch",
            Self::Expired => "expired",
            Self::NotCurrent => "not-current",
            Self::Missing => "missing",
            Self::Invalid => "invalid",
        }
    }
}

/// Typed result of a bounded writer. `Display` prints only the stable code.
#[derive(Debug)]
pub struct Nir1GenerationStoreError {
    failure: Nir1StoreFailure,
    commit: Nir1CommitState,
    claim_written_at_ms: Option<i64>,
    source: anyhow::Error,
}

impl Nir1GenerationStoreError {
    pub fn failure(&self) -> Nir1StoreFailure {
        self.failure
    }

    pub fn commit(&self) -> Nir1CommitState {
        self.commit
    }

    /// The `claimed_at_ms` this claim wrote inside its transaction. Present
    /// only when a claim reached COMMIT with an unknown outcome.
    pub fn claim_written_at_ms(&self) -> Option<i64> {
        self.claim_written_at_ms
    }

    fn not_committed(failure: Nir1StoreFailure, source: anyhow::Error) -> Self {
        Self {
            failure,
            commit: Nir1CommitState::NotCommitted,
            claim_written_at_ms: None,
            source,
        }
    }
}

impl fmt::Display for Nir1GenerationStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "NIR1_GENERATION_STORE:{}:{}",
            self.failure.code(),
            match self.commit {
                Nir1CommitState::NotCommitted => "not-committed",
                Nir1CommitState::Unknown => "commit-unknown",
            }
        )
    }
}

impl std::error::Error for Nir1GenerationStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(AsRef::<dyn std::error::Error + 'static>::as_ref(
            &self.source,
        ))
    }
}

/// Domain refusal raised inside a writer; classified before generic markers.
#[derive(Debug)]
struct Nir1DomainFailure {
    failure: Nir1StoreFailure,
    code: &'static str,
}

impl fmt::Display for Nir1DomainFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for Nir1DomainFailure {}

fn domain_failure(failure: Nir1StoreFailure, code: &'static str) -> anyhow::Error {
    anyhow::Error::new(Nir1DomainFailure { failure, code })
}

/// Immutable fields a claim/terminal writer compares inside its own
/// transaction, so another same-binding attempt cannot be substituted.
#[derive(Clone, Debug)]
pub struct Nir1ExpectedAttempt {
    pub id: String,
    pub binding: AttemptBinding,
    pub payload_digest: String,
    pub input_digest: String,
    pub inputs: Vec<InputReference>,
    pub qualifications: Vec<QualificationReference>,
    pub reference_format: ReferenceFormat,
    pub read_budget: ReadBudget,
}

impl Nir1ExpectedAttempt {
    pub fn from_stored(attempt: &StoredAttempt, read_budget: ReadBudget) -> Self {
        Self {
            id: attempt.id.clone(),
            binding: attempt.binding.clone(),
            payload_digest: attempt.payload_digest.clone(),
            input_digest: attempt.input_digest.clone(),
            inputs: attempt.inputs.clone(),
            qualifications: attempt.qualifications.clone(),
            reference_format: attempt.reference_format,
            read_budget,
        }
    }

    /// Whether a reread attempt still carries exactly these immutable fields.
    pub fn matches(&self, attempt: &StoredAttempt) -> bool {
        attempt.id == self.id
            && attempt.binding == self.binding
            && attempt.payload_digest == self.payload_digest
            && attempt.input_digest == self.input_digest
            && attempt.inputs == self.inputs
            && attempt.qualifications == self.qualifications
            && attempt.reference_format == self.reference_format
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Nir1ClaimOutcome {
    /// This writer consumed the one-shot right at `claimed_at_ms`.
    Claimed { claimed_at_ms: i64 },
    /// Some claimer already consumed it; this writer changed nothing.
    AlreadyClaimed { claimed_at_ms: i64 },
    /// A terminal is already durable; this writer changed nothing.
    AlreadyTerminal,
}

/// The claim state a zero-send writer requires inside its transaction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Nir1ExpectedClaim {
    Unclaimed,
    ClaimedAt(i64),
}

/// The only terminals a transport-less (zero-send) owner may write.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Nir1ZeroSendCompletion {
    /// Cancelled before the start decision: `Cancelled`/`not-attempted`.
    Cancelled,
    /// Any other pre-transport stop: `Failed`/`not-attempted`
    /// (`DispatchUnavailable`).
    DispatchFailure,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Nir1WritePhase {
    Preparing,
    ReadyToCommit,
}

fn ensure_no_nested_sql_owner() -> Result<(), Nir1GenerationStoreError> {
    // Checked before the participant scope and its mutex: inside a scope the
    // writer itself is on the thread-local stack, and a nested scope would not
    // own its own limits.
    if crate::narrative_extraction::nir1_capacity::attempt_active()
        || crate::narrative_maintenance_connection::any_sql_owner_scope_active()
    {
        return Err(Nir1GenerationStoreError::not_committed(
            Nir1StoreFailure::SqlOwnerActive,
            anyhow::anyhow!("NIR1_GENERATION_CLAIM_SQL_OWNER_ACTIVE"),
        ));
    }
    Ok(())
}

fn wall_clock_ms() -> Result<i64> {
    Ok(i64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

fn error_chain_contains(error: &anyhow::Error, marker: &str) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string().contains(marker))
}

fn is_sqlite_busy(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<rusqlite::Error>()
            .and_then(rusqlite::Error::sqlite_error_code)
            .is_some_and(|code| matches!(code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked))
    })
}

/// Map a writer error to its typed failure. A stop observed while the owner's
/// cancel is set is `Cancelled`; otherwise a participant stop or a false probe
/// is `Fenced`.
fn classify_store_error(error: &anyhow::Error, cancel_requested: bool) -> Nir1StoreFailure {
    let stopped = |failure| {
        if cancel_requested {
            Nir1StoreFailure::Cancelled
        } else {
            failure
        }
    };
    if error_chain_contains(error, NIR1_SQL_CONNECTION_LOCK_TIMEOUT)
        || error_chain_contains(error, "NEX_MAINTENANCE_CONNECTION_PREEMPTED")
    {
        return stopped(Nir1StoreFailure::ConnectionBusy);
    }
    if let Some(terminated) = error.downcast_ref::<ValidationTerminated>() {
        return match terminated.reason {
            ValidationTerminationReason::TimedOut => stopped(Nir1StoreFailure::TimedOut),
            ValidationTerminationReason::CleanupFailed => Nir1StoreFailure::ConnectionUnavailable,
            ValidationTerminationReason::CapacityExceeded => Nir1StoreFailure::Invalid,
            ValidationTerminationReason::ContextUnavailable
            | ValidationTerminationReason::Cancelled
            | ValidationTerminationReason::Closed
            | ValidationTerminationReason::WorkspaceGenerationChanged
            | ValidationTerminationReason::ForegroundPreempted => stopped(Nir1StoreFailure::Fenced),
        };
    }
    // The participant scope's own cleanup verdict is authoritative for the
    // connection; a transaction helper's rollback note (for example after
    // SQLite already rolled back an interrupted statement) is not.
    if [
        "NIR1_MAINTENANCE_CONNECTION_UNUSABLE",
        "NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED",
        "NEX_MAINTENANCE_CONNECTION_RETIREMENT",
    ]
    .iter()
    .any(|marker| error_chain_contains(error, marker))
    {
        return Nir1StoreFailure::ConnectionUnavailable;
    }
    if is_sqlite_busy(error) {
        return Nir1StoreFailure::SqliteBusy;
    }
    if let Some(domain) = error.downcast_ref::<Nir1DomainFailure>() {
        return domain.failure;
    }
    if error_chain_contains(error, ATTEMPT_MISSING_ERROR) {
        return Nir1StoreFailure::Missing;
    }
    if error_chain_contains(error, "NIR1_GENERATION_EXPIRED") {
        return Nir1StoreFailure::Expired;
    }
    if error_chain_contains(error, "NIR1_CHAT_CAPTURE_") {
        return Nir1StoreFailure::NotCurrent;
    }
    Nir1StoreFailure::Invalid
}

/// Run one bounded IMMEDIATE transaction and classify its commit state: an
/// error before the operation returned `Ok` is `NotCommitted`; one at or
/// after COMMIT is `Unknown`.
fn bounded_write<T>(
    workspace: &ActiveWorkspaceSnapshot,
    fence: ParticipantSqlFence,
    sql_budget: ParticipantSqlOperationBudget,
    failpoint: WriteFailpoint,
    operation: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T, (anyhow::Error, Nir1CommitState)> {
    let phase = Cell::new(Nir1WritePhase::Preparing);
    let panic_payload = Cell::new(None);
    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    let commit_failpoint = failpoint.clone();
    #[cfg(not(any(test, feature = "workspace-maintenance-test-support")))]
    let _ = failpoint;
    let result = workspace
        .authority
        .db()
        .with_participant_immediate_transaction_bounded_in(
            workspace.participant(),
            fence,
            sql_budget,
            |conn| {
                // A panic (for example in the caller's pre-commit check) is
                // turned into an ordinary error so the scope rolls back and
                // keeps the connection reusable; it resumes after the scope.
                let value = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    operation(conn)
                })) {
                    Ok(value) => value?,
                    Err(payload) => {
                        panic_payload.set(Some(payload));
                        anyhow::bail!("NIR1_GENERATION_WRITER_PANICKED");
                    }
                };
                #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
                install_commit_failpoint(conn, commit_failpoint.as_ref())?;
                phase.set(Nir1WritePhase::ReadyToCommit);
                Ok(value)
            },
        );
    if let Some(payload) = panic_payload.take() {
        std::panic::resume_unwind(payload);
    }
    let commit = match phase.get() {
        Nir1WritePhase::Preparing => Nir1CommitState::NotCommitted,
        Nir1WritePhase::ReadyToCommit => Nir1CommitState::Unknown,
    };
    match result {
        #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
        Ok(_) if matches!(failpoint, Some(Nir1GenerationFailpoint::ErrorAfterCommit)) => Err((
            anyhow::anyhow!("NIR1_GENERATION_FAILPOINT_ERROR_AFTER_COMMIT"),
            Nir1CommitState::Unknown,
        )),
        Ok(value) => Ok(value),
        Err(error) => Err((error, commit)),
    }
}

/// Install a one-shot commit hook for a test failpoint. The participant scope
/// removes any hook after the transaction returns.
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
fn install_commit_failpoint(
    conn: &Connection,
    failpoint: Option<&Nir1GenerationFailpoint>,
) -> Result<()> {
    match failpoint {
        Some(Nir1GenerationFailpoint::VetoCommit) => {
            let fired = AtomicBool::new(false);
            conn.commit_hook(Some(move || !fired.swap(true, Ordering::AcqRel)))?;
        }
        Some(Nir1GenerationFailpoint::ProbeDuringCommit(probe)) => {
            let probe = Arc::clone(probe);
            let fired = AtomicBool::new(false);
            conn.commit_hook(Some(move || {
                if !fired.swap(true, Ordering::AcqRel) {
                    probe();
                }
                false
            }))?;
        }
        Some(Nir1GenerationFailpoint::ErrorAfterCommit) | None => {}
    }
    Ok(())
}

fn store_error(
    error: anyhow::Error,
    commit: Nir1CommitState,
    cancel_requested: bool,
) -> Nir1GenerationStoreError {
    Nir1GenerationStoreError {
        failure: classify_store_error(&error, cancel_requested),
        commit,
        claim_written_at_ms: None,
        source: error,
    }
}

fn validate_expected_attempt(
    expected: &Nir1ExpectedAttempt,
) -> Result<(), Nir1GenerationStoreError> {
    identity(&expected.id)
        .and_then(|()| validate_binding(&expected.binding))
        .and_then(|()| digest(&expected.payload_digest))
        .and_then(|()| digest(&expected.input_digest))
        .map_err(|error| Nir1GenerationStoreError::not_committed(Nir1StoreFailure::Invalid, error))
}

/// Read the attempt and require exactly the expected immutable fields.
fn read_expected_attempt_in_tx(
    conn: &Connection,
    expected: &Nir1ExpectedAttempt,
) -> Result<StoredAttempt> {
    let stored = read_attempt_in_tx(conn, &expected.id, expected.read_budget)?;
    if !expected.matches(&stored) {
        return Err(domain_failure(
            Nir1StoreFailure::Conflict,
            "NIR1_GENERATION_ATTEMPT_CONFLICT",
        ));
    }
    Ok(stored)
}

/// Deterministic attempt identity of one accepted Human submission. The same
/// submission always resolves to the same attempt; a resend never creates a
/// second one, and an unknown create outcome is reread by this exact ID.
#[cfg(feature = "native-current-human-capture")]
pub fn attempt_id_for_capture(capture: &AcceptedChatInputCapture) -> Result<String> {
    Ok(canonical_json_digest(&json!({
        "domain": "nir1-generation-attempt-id@1",
        "captureId": capture.capture_id,
        "submissionId": capture.submission_id,
        "submissionDigest": capture.submission_digest,
    }))?)
}

/// Create the attempt of one exact current Human capture. The binding must
/// carry the capture's project, chat session and caller (including the
/// caller's Main session); the inputs must include its Human message
/// version; and the capture row must still be the exact current one inside
/// the same transaction.
#[cfg(feature = "native-current-human-capture")]
pub fn create_attempt_for_capture_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    capture: &AcceptedChatInputCapture,
    request: NewAttempt,
    budget: &Nir1AdmissionSqlBudget,
    pre_commit: &mut dyn FnMut() -> Result<()>,
) -> Result<StoredAttempt, Nir1GenerationStoreError> {
    ensure_no_nested_sql_owner()?;
    let owner = &capture.owner;
    let human_input = request.inputs.iter().any(|input| {
        input.role == InputRole::User
            && matches!(
                &input.target,
                InputTarget::Message { version_id, parent_attempt_id: None }
                    if version_id == &capture.message_version_id
            )
    });
    if request.binding.project_id != capture.project_id
        || request.binding.chat_session_id != capture.chat_session_id
        || request.binding.caller.profile_id != owner.profile_id
        || request.binding.caller.caller_id != owner.caller_id
        || request.binding.caller.caller_epoch != owner.caller_epoch
        || request.binding.caller.caller_session_id != owner.caller_session_id
        || !human_input
    {
        return Err(Nir1GenerationStoreError::not_committed(
            Nir1StoreFailure::Conflict,
            domain_failure(
                Nir1StoreFailure::Conflict,
                "NIR1_GENERATION_CAPTURE_BINDING_MISMATCH",
            ),
        ));
    }
    if owner.workspace_locator.as_str() != workspace.path().to_string_lossy().as_ref()
        || owner.workspace_authority_instance != workspace.authority.identity()
    {
        return Err(Nir1GenerationStoreError::not_committed(
            Nir1StoreFailure::NotCurrent,
            domain_failure(
                Nir1StoreFailure::NotCurrent,
                "NIR1_GENERATION_CAPTURE_WORKSPACE_MISMATCH",
            ),
        ));
    }
    let id = attempt_id_for_capture(capture).map_err(|error| {
        Nir1GenerationStoreError::not_committed(Nir1StoreFailure::Invalid, error)
    })?;
    create_attempt_with_id_bounded_checked(workspace, &id, request, budget, pre_commit, |conn| {
        read_current_chat_input_capture_in_tx(conn, capture, owner, |_, _| Ok(()))
            .map(|_| ())
            .map_err(|error| {
                if is_sqlite_busy(&error) {
                    error
                } else {
                    error.context(Nir1DomainFailure {
                        failure: Nir1StoreFailure::NotCurrent,
                        code: "NIR1_GENERATION_CAPTURE_NOT_CURRENT",
                    })
                }
            })
    })
}

/// Capture-independent bounded create (the same core as the capture form),
/// for storage tests that run without the capture feature.
#[cfg(test)]
pub(crate) fn create_attempt_with_id_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    id: &str,
    request: NewAttempt,
    budget: &Nir1AdmissionSqlBudget,
    pre_commit: &mut dyn FnMut() -> Result<()>,
) -> Result<StoredAttempt, Nir1GenerationStoreError> {
    ensure_no_nested_sql_owner()?;
    create_attempt_with_id_bounded_checked(workspace, id, request, budget, pre_commit, |_| Ok(()))
}

// Production creates exist only in the Native capture build.
#[cfg_attr(not(feature = "native-current-human-capture"), allow(dead_code))]
fn create_attempt_with_id_bounded_checked(
    workspace: &ActiveWorkspaceSnapshot,
    id: &str,
    request: NewAttempt,
    budget: &Nir1AdmissionSqlBudget,
    pre_commit: &mut dyn FnMut() -> Result<()>,
    current_in_tx: impl FnOnce(&Connection) -> Result<()>,
) -> Result<StoredAttempt, Nir1GenerationStoreError> {
    identity(id)
        .and_then(|()| validate_new_attempt(&request))
        .map_err(|error| {
            Nir1GenerationStoreError::not_committed(Nir1StoreFailure::Invalid, error)
        })?;
    bounded_write(
        workspace,
        budget.fence(),
        budget.sql_budget(),
        budget.failpoint(),
        |conn| {
            current_in_tx(conn)?;
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM nir1_generation_attempts WHERE id=?1)",
                [id],
                |row| row.get(0),
            )?;
            if exists {
                return Err(domain_failure(
                    Nir1StoreFailure::AlreadyExists,
                    "NIR1_GENERATION_ATTEMPT_EXISTS",
                ));
            }
            require_bound_session_and_scene(conn, &request.binding)?;
            validate_refs(
                conn,
                &request.binding,
                &request.inputs,
                &request.qualifications,
                request.budget,
            )?;
            let stored = insert_attempt_in_tx(conn, id, &request, false)?;
            pre_commit()?;
            Ok(stored)
        },
    )
    .map_err(|(error, commit)| store_error(error, commit, budget.cancel_requested()))
}

/// Consume the durable one-shot right of the exact expected attempt. This is a
/// CAS only, never transport permission: the caller revalidates its external
/// authorities after COMMIT and before it starts a transport.
pub fn claim_attempt_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    expected: &Nir1ExpectedAttempt,
    budget: &Nir1AdmissionSqlBudget,
    pre_commit: &mut dyn FnMut() -> Result<()>,
) -> Result<Nir1ClaimOutcome, Nir1GenerationStoreError> {
    ensure_no_nested_sql_owner()?;
    validate_expected_attempt(expected)?;
    let written_at_ms = Cell::new(None);
    bounded_write(
        workspace,
        budget.fence(),
        budget.sql_budget(),
        budget.failpoint(),
        |conn| {
            let stored = read_expected_attempt_in_tx(conn, expected)?;
            if stored.terminal.is_some() {
                return Ok(Nir1ClaimOutcome::AlreadyTerminal);
            }
            if let Some(claimed_at_ms) = stored.claimed_at_ms {
                return Ok(Nir1ClaimOutcome::AlreadyClaimed { claimed_at_ms });
            }
            ensure!(
                stored.reference_format == ReferenceFormat::V2,
                "{}",
                REFERENCE_LEGACY_TERMINAL_ONLY_ERROR
            );
            let now_ms = wall_clock_ms()?;
            if now_ms < stored.created_at_ms || now_ms >= stored.expires_at_ms {
                return Err(domain_failure(
                    Nir1StoreFailure::Expired,
                    "NIR1_GENERATION_EXPIRED",
                ));
            }
            require_bound_session_and_scene(conn, &stored.binding)?;
            validate_refs(
                conn,
                &stored.binding,
                &stored.inputs,
                &stored.qualifications,
                expected.read_budget,
            )?;
            let updated = conn.execute(
                "UPDATE nir1_generation_attempts SET claimed_at_ms=?2
                  WHERE id=?1 AND claimed_at_ms IS NULL AND terminal_json IS NULL",
                params![expected.id, now_ms],
            )?;
            if updated != 1 {
                return Err(domain_failure(
                    Nir1StoreFailure::Conflict,
                    "NIR1_GENERATION_CLAIM_CONFLICT",
                ));
            }
            // Recorded before COMMIT, so an unknown outcome always carries the
            // exact time this writer used.
            written_at_ms.set(Some(now_ms));
            pre_commit()?;
            Ok(Nir1ClaimOutcome::Claimed {
                claimed_at_ms: now_ms,
            })
        },
    )
    .map_err(|(error, commit)| {
        let mut error = store_error(error, commit, budget.cancel_requested());
        if commit == Nir1CommitState::Unknown {
            error.claim_written_at_ms = written_at_ms.get();
        }
        error
    })
}

/// Write the transport-less terminal of an exact attempt, exactly once. The
/// claim state is compared before any existing terminal, inside the same
/// transaction, so an attempt claimed by another claimer is never
/// terminalized here. An identical earlier write of this terminal (same
/// observation and classification) is returned unchanged.
pub fn finish_pretransport_attempt_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    expected: &Nir1ExpectedAttempt,
    claim: Nir1ExpectedClaim,
    completion: Nir1ZeroSendCompletion,
    budget: &Nir1PinnedSqlBudget,
) -> Result<StoredTerminal, Nir1GenerationStoreError> {
    ensure_no_nested_sql_owner()?;
    validate_expected_attempt(expected)?;
    let (observation, classification) = match completion {
        Nir1ZeroSendCompletion::Cancelled => (
            OutputObserver::new().finish(Completion::Cancelled),
            FailureClassification::Cancelled,
        ),
        Nir1ZeroSendCompletion::DispatchFailure => (
            OutputObserver::new().finish(Completion::DispatchFailure),
            FailureClassification::DispatchUnavailable,
        ),
    };
    let observation_value = serde_json::to_value(&observation).map_err(|error| {
        Nir1GenerationStoreError::not_committed(Nir1StoreFailure::Invalid, error.into())
    })?;
    bounded_write(
        workspace,
        ParticipantSqlFence::Pinned,
        budget.sql_budget(),
        budget.failpoint(),
        |conn| {
            let stored = read_expected_attempt_in_tx(conn, expected)?;
            let claim_matches = match claim {
                Nir1ExpectedClaim::Unclaimed => stored.claimed_at_ms.is_none(),
                Nir1ExpectedClaim::ClaimedAt(claimed_at_ms) => {
                    stored.claimed_at_ms == Some(claimed_at_ms)
                }
            };
            if !claim_matches {
                return Err(domain_failure(
                    Nir1StoreFailure::ClaimMismatch,
                    "NIR1_GENERATION_ZERO_SEND_CLAIM_MISMATCH",
                ));
            }
            if let Some(existing) = stored.terminal {
                if existing.message_version.is_none()
                    && existing.observation == observation_value
                    && existing.failure_classification.as_ref() == Some(&classification)
                {
                    return Ok(existing);
                }
                return Err(domain_failure(
                    Nir1StoreFailure::TerminalConflict,
                    "NIR1_GENERATION_TERMINAL_CONFLICT",
                ));
            }
            // No provider event happened: like recovery, never place this
            // terminal before the durable create/claim on a regressed clock.
            let now_ms = wall_clock_ms()?
                .max(stored.created_at_ms)
                .max(stored.claimed_at_ms.unwrap_or(stored.created_at_ms));
            finish_in_tx(
                conn,
                &expected.id,
                &observation,
                None,
                now_ms,
                false,
                AuditClose::ZeroSend,
            )
        },
    )
    .map_err(|(error, commit)| store_error(error, commit, false))
}

/// Write the post-transport terminal of the exact claimed attempt. Without
/// audit data; [`finish_attempt_with_audit_bounded`] is the same writer that
/// records what the transport observed.
pub fn finish_attempt_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    expected: &Nir1ExpectedAttempt,
    observation: &TerminalObservation,
    body: Option<NewMessageBody>,
    now_ms: i64,
    budget: &Nir1PinnedSqlBudget,
) -> Result<StoredTerminal, Nir1GenerationStoreError> {
    finish_attempt_bounded_with(
        workspace,
        expected,
        observation,
        body,
        now_ms,
        AuditClose::Conservative,
        budget,
    )
}

/// Conservatively terminalize the exact claimed attempt whose transport owner
/// ended without a terminal (`InterruptedUnknown`). An existing terminal is
/// returned unchanged; nothing is resent.
pub fn recover_claimed_attempt_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    expected: &Nir1ExpectedAttempt,
    budget: &Nir1PinnedSqlBudget,
) -> Result<StoredTerminal, Nir1GenerationStoreError> {
    ensure_no_nested_sql_owner()?;
    validate_expected_attempt(expected)?;
    bounded_write(
        workspace,
        ParticipantSqlFence::Pinned,
        budget.sql_budget(),
        budget.failpoint(),
        |conn| {
            read_expected_attempt_in_tx(conn, expected)?;
            recover_attempt_in_tx(conn, &expected.id, wall_clock_ms()?)
        },
    )
    .map_err(|(error, commit)| store_error(error, commit, false))
}

/// Clean bounded reread of one exact attempt in a fresh read transaction.
/// `Ok(None)` is a confirmed absence, never a timeout or error.
pub fn read_attempt_exact_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    id: &str,
    read_budget: ReadBudget,
    budget: &Nir1PinnedSqlBudget,
) -> Result<Option<StoredAttempt>, Nir1GenerationStoreError> {
    ensure_no_nested_sql_owner()?;
    identity(id).map_err(|error| {
        Nir1GenerationStoreError::not_committed(Nir1StoreFailure::Invalid, error)
    })?;
    workspace
        .authority
        .db()
        .with_participant_read_transaction_bounded_in(
            workspace.participant(),
            ParticipantSqlFence::Pinned,
            budget.sql_budget(),
            |conn| match read_attempt_in_tx(conn, id, read_budget) {
                Ok(attempt) => Ok(Some(attempt)),
                Err(error) if is_confirmed_missing_attempt(&error) => Ok(None),
                Err(error) => Err(error),
            },
        )
        .map_err(|error| store_error(error, Nir1CommitState::NotCommitted, false))
}

/// The pinned workspace is still the exact Ready binding, not quarantined and
/// not switching. Takes the lifecycle lock briefly; never the DB mutex.
pub fn ensure_attempt_workspace_current(
    workspace: &ActiveWorkspaceSnapshot,
) -> Result<(), Nir1GenerationStoreError> {
    workspace.check_current_binding().map_err(|error| {
        Nir1GenerationStoreError::not_committed(Nir1StoreFailure::NotCurrent, error)
    })
}

/// Test-support: hold a C-query style quarantine of the exact Ready workspace
/// (a revision-only lifecycle change). Dropping the value releases it.
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub struct Nir1WorkspaceQuarantineForTest {
    _fence: crate::workspace_lifecycle::WorkspaceQuarantineFence,
}

#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub fn quarantine_workspace_for_test(
    workspace: ActiveWorkspaceSnapshot,
) -> Option<Nir1WorkspaceQuarantineForTest> {
    workspace
        .detach_c_query_quarantine()
        .map(|fence| Nir1WorkspaceQuarantineForTest { _fence: fence })
}

/// Exact ascending keyset page of projects with pending attempts in this workspace.
/// Filter before LIMIT so empty/terminal-only projects cannot starve fresh sweeps.
/// Startup recovery has no caller-selected project filter.
pub fn pending_project_id_page_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    after_id: Option<&str>,
    limit: usize,
    budget: ParticipantSqlOperationBudget,
) -> Result<Vec<String>> {
    ensure!(
        limit > 0 && limit <= MAX_RECOVERY_PAGE_SIZE,
        "NIR1_GENERATION_RECOVERY_INVALID_PAGE_SIZE"
    );
    if let Some(after_id) = after_id {
        identity(after_id)?;
    }
    workspace
        .authority
        .db()
        .with_participant_read_transaction_bounded(workspace.participant(), budget, |conn| {
            let mut statement = conn.prepare(
                "SELECT p.rowid,octet_length(p.id) FROM projects AS p
                 WHERE p.id>?1 AND EXISTS (
                     SELECT 1 FROM nir1_generation_attempts AS a
                     WHERE a.project_id=p.id AND a.terminal_json IS NULL
                 ) ORDER BY p.id LIMIT ?2",
            )?;
            let mut rows =
                statement.query(params![after_id.unwrap_or(""), i64::try_from(limit)?])?;
            let mut locations = Vec::new();
            while let Some(row) = rows.next()? {
                locations.push((
                    row.get::<_, i64>(0)?,
                    bounded_sqlite_length(
                        row.get::<_, i64>(1)?,
                        MAX_ID_BYTES,
                        "NIR1_GENERATION_PROJECT_METADATA_LIMIT",
                    )?,
                ));
            }
            drop(rows);
            let mut point = conn.prepare("SELECT id FROM projects WHERE rowid=?1")?;
            let mut result = Vec::with_capacity(locations.len());
            for (rowid, expected_bytes) in locations {
                let id: String = point.query_row([rowid], |row| row.get(0))?;
                identity(&id)?;
                ensure!(
                    id.len() == expected_bytes,
                    "NIR1_GENERATION_PROJECT_METADATA_CHANGED"
                );
                result.push(id);
            }
            Ok(result)
        })
}

/// Keyset pages are scoped before LIMIT. The recovery owner exhausts pages;
/// an empty global sample is never evidence that this project's work is absent.
/// Unbounded test-support form of [`pending_attempt_id_page_bounded`].
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub fn pending_attempt_ids(
    db: &Database,
    project: &str,
    after_id: Option<&str>,
    limit: usize,
) -> Result<Vec<String>> {
    ensure!(limit > 0, "NIR1_GENERATION_INVALID_LIMIT");
    identity(project)?;
    if let Some(after_id) = after_id {
        identity(after_id)?;
    }
    db.with_read_transaction(|conn| pending_attempt_id_page_in_tx(conn, project, after_id, limit))
}

/// Bounded, participant-controlled pending-attempt page for restart recovery.
pub fn pending_attempt_id_page_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    project: &str,
    after_id: Option<&str>,
    limit: usize,
    budget: ParticipantSqlOperationBudget,
) -> Result<Vec<String>> {
    ensure!(
        limit > 0 && limit <= MAX_RECOVERY_PAGE_SIZE,
        "NIR1_GENERATION_RECOVERY_INVALID_PAGE_SIZE"
    );
    identity(project)?;
    if let Some(after_id) = after_id {
        identity(after_id)?;
    }
    workspace
        .authority
        .db()
        .with_participant_read_transaction_bounded(workspace.participant(), budget, |conn| {
            pending_attempt_id_page_in_tx(conn, project, after_id, limit)
        })
}

fn pending_attempt_id_page_in_tx(
    conn: &Connection,
    project: &str,
    after_id: Option<&str>,
    limit: usize,
) -> Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT rowid,octet_length(id) FROM nir1_generation_attempts
         WHERE project_id=?1 AND terminal_json IS NULL AND id>?2 ORDER BY id LIMIT ?3",
    )?;
    let mut rows = statement.query(params![
        project,
        after_id.unwrap_or(""),
        i64::try_from(limit)?
    ])?;
    let mut locations = Vec::new();
    while let Some(row) = rows.next()? {
        let rowid = row.get::<_, i64>(0)?;
        let id_length = bounded_sqlite_length(
            row.get::<_, i64>(1)?,
            MAX_ID_BYTES,
            "NIR1_GENERATION_ATTEMPT_METADATA_LIMIT",
        )?;
        locations.push((rowid, id_length));
    }
    drop(rows);
    let mut point = conn.prepare("SELECT id FROM nir1_generation_attempts WHERE rowid=?1")?;
    let mut result = Vec::with_capacity(locations.len());
    for (rowid, expected_bytes) in locations {
        let id: String = point.query_row([rowid], |row| row.get(0))?;
        identity(&id)?;
        ensure!(
            id.len() == expected_bytes,
            "NIR1_GENERATION_ATTEMPT_METADATA_CHANGED"
        );
        result.push(id);
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
