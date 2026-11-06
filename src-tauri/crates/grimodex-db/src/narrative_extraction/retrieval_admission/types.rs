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
    pub(super) revision_id: String,
    /// Snapshot document/evidence aliases are scoped to this original Run.
    pub(super) owning_run_id: String,
    pub(super) proposal_id: String,
    pub(super) envelope_digest: String,
    pub(super) current_decision: RevisionEligibilityDecision,
    pub(super) material_basis_digest: String,
    pub(super) dependency_ids: Vec<String>,
    pub(super) query_context: RetrievalQueryContext,
    pub(super) canonical_freshness: RevisionFreshnessSnapshot,
    pub(super) document: ChronicleRetrievalDocument,
    pub(super) evidence: Vec<MaterialEvidenceEntry>,
    pub(super) _verified: (),
}

impl RevisionEligibilitySnapshot {
    pub fn revision_id(&self) -> &str {
        &self.revision_id
    }

    pub fn owning_run_id(&self) -> &str {
        &self.owning_run_id
    }

    pub fn proposal_id(&self) -> &str {
        &self.proposal_id
    }

    pub fn envelope_digest(&self) -> &str {
        &self.envelope_digest
    }

    pub fn current_decision_id(&self) -> &str {
        self.current_decision.id()
    }

    pub fn material_basis_digest(&self) -> &str {
        &self.material_basis_digest
    }

    pub fn dependency_ids(&self) -> &[String] {
        &self.dependency_ids
    }

    pub fn query_context(&self) -> &RetrievalQueryContext {
        &self.query_context
    }

    pub fn canonical_freshness(&self) -> &RevisionFreshnessSnapshot {
        &self.canonical_freshness
    }

    pub fn document(&self) -> &ChronicleRetrievalDocument {
        &self.document
    }

    pub fn evidence(&self) -> &[MaterialEvidenceEntry] {
        &self.evidence
    }

    pub fn current_decision(&self) -> &RevisionEligibilityDecision {
        &self.current_decision
    }
}

/// The exact current Decision row consumed by the A2 reader. It is transient
/// reader output, not a new persisted authority or wire schema.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevisionEligibilityDecision {
    pub(super) id: String,
    pub(super) revision_id: String,
    pub(super) decision: String,
    pub(super) decision_json: String,
    pub(super) actor_kind: String,
    pub(super) actor_id: String,
    pub(super) authority_scope: Option<String>,
}

impl RevisionEligibilityDecision {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn revision_id(&self) -> &str {
        &self.revision_id
    }

    pub fn decision(&self) -> &str {
        &self.decision
    }

    pub fn decision_json(&self) -> &str {
        &self.decision_json
    }

    pub fn actor_kind(&self) -> &str {
        &self.actor_kind
    }

    pub fn actor_id(&self) -> &str {
        &self.actor_id
    }

    pub fn authority_scope(&self) -> Option<&str> {
        self.authority_scope.as_deref()
    }
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
    /// `authority.mappings` position by `source_key`, built once with the
    /// authority. The first mapping of a key wins, exactly like
    /// `mappings.iter().find(|m| m.source_key == key)`.
    pub(super) mapping_position_by_source_key: std::collections::HashMap<String, usize>,
    pub(super) _verified: (),
}

impl RetrievalQueryContext {
    /// Positions index `authority.mappings`, so the index assumes the authority is not
    /// mutated after construction (it is built once in `query_context` and never changed).
    /// The first authority mapping of `source_key`, or `None`. Same answer as a
    /// linear `find`, without a scan per candidate.
    pub(super) fn mapping_for_source_key(
        &self,
        source_key: &str,
    ) -> Option<
        &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityMappingV1,
    > {
        self.mapping_position_by_source_key
            .get(source_key)
            .map(|&position| &self.authority.mappings[position])
    }
}

/// First-wins position index of `authority.mappings` by `source_key`.
pub(super) fn index_mappings_by_source_key(
    authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
) -> std::collections::HashMap<String, usize> {
    let mut positions = std::collections::HashMap::with_capacity(authority.mappings.len());
    for (position, mapping) in authority.mappings.iter().enumerate() {
        positions
            .entry(mapping.source_key.clone())
            .or_insert(position);
    }
    positions
}

#[cfg(test)]
mod mapping_index_tests {
    use super::*;
    use grimodex_core::narrative_project_scope_authority::{
        build_narrative_project_scope_authority_v1, NarrativeProjectScopeAuthoritySceneInputV1,
        NarrativeProjectScopeAuthorityV1,
    };

    fn authority(scene_ids: &[&str]) -> NarrativeProjectScopeAuthorityV1 {
        let scenes = scene_ids
            .iter()
            .map(|id| NarrativeProjectScopeAuthoritySceneInputV1 {
                scene_id: (*id).into(),
                raw_story_key: None,
            })
            .collect::<Vec<_>>();
        build_narrative_project_scope_authority_v1("p1", &scenes).expect("authority")
    }

    fn source_keys(authority: &NarrativeProjectScopeAuthorityV1) -> Vec<String> {
        authority
            .mappings
            .iter()
            .map(|m| m.source_key.clone())
            .collect()
    }

    /// The index answers exactly what `find` answered: the same mapping (by
    /// position), for present, repeated and absent keys.
    fn assert_same_as_find(authority: &NarrativeProjectScopeAuthorityV1, keys: &[&str]) {
        let index = index_mappings_by_source_key(authority);
        for key in keys {
            let by_find = authority.mappings.iter().position(|m| m.source_key == *key);
            let by_index = index.get(*key).copied();
            assert_eq!(by_index, by_find, "key {key}");
        }
    }

    #[test]
    fn index_matches_find_for_present_and_absent_keys_in_any_order() {
        let mut forward = authority(&["a", "b", "c", "d"]);
        let mut keys = source_keys(&forward);
        keys.extend(["project:absent".to_owned(), String::new()]);
        let keys = keys.iter().map(String::as_str).collect::<Vec<_>>();
        assert_same_as_find(&forward, &keys);
        forward.mappings.reverse();
        assert_same_as_find(&forward, &keys);
    }

    #[test]
    fn index_keeps_the_first_mapping_of_a_repeated_key_like_find() {
        let mut repeated = authority(&["a", "b", "c"]);
        // A later mapping for the same key, with a different Scene: `find`
        // answers the first one, so must the index.
        let mut later = repeated.mappings[0].clone();
        later.scene_ref = "scene:later".into();
        later.reading_rank = 99;
        repeated.mappings.push(later);
        let keys = source_keys(&repeated);
        let keys = keys.iter().map(String::as_str).collect::<Vec<_>>();
        let repeated_key = repeated.mappings[0].source_key.clone();
        let index = index_mappings_by_source_key(&repeated);
        assert_same_as_find(&repeated, &keys);
        assert_eq!(index[&repeated_key], 0);
        assert_ne!(repeated.mappings[index[&repeated_key]].reading_rank, 99);
        // And with the repeat placed before the original.
        repeated.mappings.rotate_right(1);
        assert_same_as_find(&repeated, &keys);
        assert_eq!(
            repeated.mappings[index_mappings_by_source_key(&repeated)[&repeated_key]].reading_rank,
            99
        );
    }

    #[test]
    fn index_of_an_empty_authority_has_no_key() {
        let mut empty = authority(&["a"]);
        empty.mappings.clear();
        assert!(index_mappings_by_source_key(&empty).is_empty());
        assert_same_as_find(&empty, &["project:a", "project:scene:a"]);
    }
}
