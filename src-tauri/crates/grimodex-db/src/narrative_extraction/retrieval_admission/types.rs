use super::super::human_material_basis::MaterialEvidenceEntry;
use super::super::revision_eligibility::{RevisionFreshnessReason, RevisionFreshnessSnapshot};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RevisionEligibilityReason {
    MembershipUnavailable,
    RevisionNotCurrentHumanApproved,
    QueryContextUnavailable,
    UnsupportedQueryAxis,
    StaticContractUnclassified,
    ScopeControlUnclassified,
    MaterialAuthorityUnavailable,
    SourceNotBeforeQuery,
    Secret,
    ScopeUnresolved,
    ScopeUnsupported,
    EvidenceMismatch,
    BindingInvalid,
    CanonicalFreshness(RevisionFreshnessReason),
}

#[derive(Debug)]
// This transient read result owns its verified snapshot and is consumed
// immediately; keep the payload inline instead of adding a heap allocation.
#[allow(clippy::large_enum_variant)]
pub enum RevisionEligibilityRead {
    Eligible(RevisionEligibilitySnapshot),
    Unavailable { reason: RevisionEligibilityReason },
}

#[derive(Debug)]
// The private field restricts construction to the verification owner,
// including within this crate; #[non_exhaustive] would only restrict outsiders.
#[allow(clippy::manual_non_exhaustive)]
pub struct RevisionEligibilitySnapshot {
    pub revision_id: String,
    /// Snapshot document/evidence aliases are scoped to this original Run.
    pub owning_run_id: String,
    pub proposal_id: String,
    pub envelope_digest: String,
    pub current_decision_id: String,
    pub query_context: RetrievalQueryContext,
    pub canonical_freshness: RevisionFreshnessSnapshot,
    pub document: ChronicleRetrievalDocument,
    pub evidence: Vec<MaterialEvidenceEntry>,
    pub(super) _verified: (),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChronicleRetrievalDocument {
    pub revision_id: String,
    pub envelope_digest: String,
    pub serializer_ref: &'static str,
    pub serialized_statement: String,
    pub serialized_statement_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QueryIdentityState {
    Resolved(String),
    NotApplicable { reason: &'static str },
    Unavailable { reason: &'static str },
}

#[derive(Debug)]
// This transient read result owns its verified snapshot and is consumed
// immediately; keep the payload inline instead of adding a heap allocation.
#[allow(clippy::large_enum_variant)]
pub enum RetrievalQueryContextRead {
    Available(RetrievalQueryContext),
    Unavailable { reason: RevisionEligibilityReason },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetrievalSceneSourceBinding {
    pub source_key: String,
    pub revision_token: String,
    pub source_version: i64,
    pub normalizer_version: &'static str,
    pub canonical_text_digest: String,
    pub storage_digest: String,
    pub canonical_utf16_length: usize,
}

#[derive(Debug)]
// This transient read result owns its verified snapshot and is consumed
// immediately; keep the payload inline instead of adding a heap allocation.
#[allow(clippy::large_enum_variant)]
pub enum RetrievalSceneSourceRead {
    Available(RetrievalSceneSource),
    Unavailable { reason: RevisionEligibilityReason },
}

/// Saved Scene source authority for the existing Raw query, independent of
/// whether the IR profile or Index is available for this Scene.
#[derive(Debug)]
// The private field restricts construction to the verification owner,
// including within this crate; #[non_exhaustive] would only restrict outsiders.
#[allow(clippy::manual_non_exhaustive)]
pub struct RetrievalSceneSource {
    pub project_id: String,
    pub scene_id: String,
    pub phase_resolution_mode: String,
    pub archived: bool,
    pub query_source: RetrievalSceneSourceBinding,
    pub saved_content_json: String,
    pub canonical_source_text: String,
    pub(super) _verified: (),
}

/// Native-only input context. It intentionally cannot be serialized to a UI
/// response or deserialized as a caller-supplied qualification.
#[derive(Debug)]
pub struct RetrievalQueryContext {
    pub project_id: String,
    pub query_scene_id: String,
    pub query_scene_ref: String,
    pub query_reading_rank: u64,
    pub phase_resolution_mode: String,
    pub effective_axis: &'static str,
    pub axis_fallback_reason: Option<String>,
    pub audience: QueryIdentityState,
    pub viewpoint: QueryIdentityState,
    pub knowledge_holder: QueryIdentityState,
    pub timeline: QueryIdentityState,
    pub worldline: QueryIdentityState,
    pub narrative_layer: QueryIdentityState,
    pub reading_order: QueryIdentityState,
    pub story_time: QueryIdentityState,
    pub allow_secrets: bool,
    pub scope_authority_source_key: String,
    pub scope_authority_revision_token: String,
    pub query_source: RetrievalSceneSourceBinding,
    /// Exact persisted storage for the existing Raw-query conversion. The
    /// adapter must preserve its established JS trim/last-500-UTF16 parity.
    pub saved_content_json: String,
    /// Evidence/Scope canonical body. Never substitute it for the Raw query.
    pub canonical_source_text: String,
    pub(super) authority:
        grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
    pub(super) _verified: (),
}
