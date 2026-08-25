//! Typed NIR-0 historical scope-authority basis contract.
//!
//! This module deliberately validates only a sealed, run-relative basis. It is
//! not a current-project Oracle, a producer, a resolver, or runtime routing.
//! Wire data is decoded into closed serde types before the small cross-field
//! invariants and the five explicit digest domains are checked.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::canonical_json::canonical_json_digest;
use crate::contract_string::is_contract_trimmed_non_empty;

pub const NARRATIVE_SCOPE_AUTHORITY_BASIS_SCHEMA_VERSION: u64 = 2;
pub const NARRATIVE_SCOPE_AUTHORITY_BASIS_CONTRACT_ID: &str = "narrative-scope-authority-basis/2";
pub const NARRATIVE_SCOPE_AUTHORITY_BASIS_KIND: &str = "historical-run-snapshot";
pub const NARRATIVE_SCOPE_AUTHORITY_SOURCE_KIND: &str = "snapshot-document";
pub const NARRATIVE_SCOPE_AUTHORITY_REGISTRY_VERSION: &str = "narrative-scope/2";

const SCOPE_REGISTRY_REVISION_CONTRACT_ID: &str = "narrative-scope-registry-revision/1";
const READING_ORDER_REVISION_CONTRACT_ID: &str = "narrative-reading-order-revision/1";
const STORY_TIME_ORDER_REVISION_CONTRACT_ID: &str = "narrative-story-time-order-revision/1";
const SCOPE_AUTHORITY_DIGEST_CONTRACT_ID: &str = "narrative-scope-authority/2";
const SOURCE_SNAPSHOT_REVISION_CONTRACT_ID: &str = "narrative-source-snapshot-revision/2";

const SOURCE_SNAPSHOT_PREFIX: &str = "snapshot:";
const PROJECT_SCENE_PREFIX: &str = "project:scene:";
const SCENE_REF_PREFIX: &str = "scene:";
const READING_REF_PREFIX: &str = "reading:";
const STORY_REF_PREFIX: &str = "story:";
const MAX_DOCUMENT_COUNT: usize = 999_999;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeScopeAuthorityBasisV2 {
    pub schema_version: u64,
    pub contract_id: String,
    pub basis_kind: String,
    pub project_id: String,
    pub source: NarrativeScopeAuthoritySourceV2,
    pub scope_registry: NarrativeScopeAuthorityRegistryV2,
    pub mappings: Vec<NarrativeScopeAuthorityMappingV2>,
    pub digests: NarrativeScopeAuthorityDigestsV2,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeScopeAuthoritySourceV2 {
    pub source_kind: String,
    pub source_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeScopeAuthorityRegistryV2 {
    pub registry_version: String,
    pub reserved_audience_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeScopeAuthorityMappingV2 {
    pub document_ref: String,
    pub source_key: String,
    pub scene_ref: String,
    pub reading_order_ref: String,
    pub story_time_ref: String,
    pub reading_rank: u64,
    pub story_time_order: NarrativeScopeAuthorityStoryTimeOrderV2,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NarrativeScopeAuthorityStoryTimeOrderV2 {
    Resolved {
        raw_story_key: String,
        story_rank: u64,
    },
    Unresolved {
        reason: NarrativeScopeAuthorityUnresolvedReasonV2,
        #[serde(deserialize_with = "deserialize_required_nullable_story_key")]
        raw_story_key: NarrativeScopeAuthorityNullableStoryKeyV2,
    },
}

impl NarrativeScopeAuthorityStoryTimeOrderV2 {
    pub(crate) fn unresolved_not_provided() -> Self {
        Self::Unresolved {
            reason: NarrativeScopeAuthorityUnresolvedReasonV2::NotProvided,
            raw_story_key: NarrativeScopeAuthorityNullableStoryKeyV2(None),
        }
    }

    pub(crate) fn unresolved_ambiguous(raw_story_key: String) -> Self {
        Self::Unresolved {
            reason: NarrativeScopeAuthorityUnresolvedReasonV2::Ambiguous,
            raw_story_key: NarrativeScopeAuthorityNullableStoryKeyV2(Some(raw_story_key)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NarrativeScopeAuthorityUnresolvedReasonV2 {
    NotProvided,
    Ambiguous,
}

/// Required nullable scalar used to distinguish an explicit JSON `null` from
/// a missing `rawStoryKey` field. A plain `Option<String>` would accept both.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NarrativeScopeAuthorityNullableStoryKeyV2(Option<String>);

impl NarrativeScopeAuthorityNullableStoryKeyV2 {
    fn as_deref(&self) -> Option<&str> {
        self.0.as_deref()
    }
}

impl Serialize for NarrativeScopeAuthorityNullableStoryKeyV2 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.0.serialize(serializer)
    }
}

fn deserialize_required_nullable_story_key<'de, D>(
    deserializer: D,
) -> Result<NarrativeScopeAuthorityNullableStoryKeyV2, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(NarrativeScopeAuthorityNullableStoryKeyV2)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeScopeAuthorityDigestsV2 {
    pub corpus_digest: String,
    pub scope_registry_revision: String,
    pub reading_order_revision: String,
    pub story_time_order_revision: String,
    pub authority_digest: String,
    pub composite_digest: String,
}

/// Native-only authority supplied by the future resolver. This deliberately
/// has no serde wire representation: an untrusted payload cannot nominate its
/// own project/source/revision binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NarrativeScopeAuthorityTrustedContextV2 {
    pub project_id: String,
    pub source_key: String,
    pub expected_composite_digest: String,
    pub documents: Vec<NarrativeScopeAuthoritySourceDocumentV2>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NarrativeScopeAuthoritySourceDocumentV2 {
    pub document_ref: String,
    pub source_key: String,
    pub project_id: String,
    pub node_id: String,
}

/// Ordered Native input used to build a historical basis. The caller owns the
/// reading order; this module derives every axis identity and story-time rank.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NarrativeScopeAuthorityDocumentInputV2 {
    pub document_ref: String,
    pub source_key: String,
    pub raw_story_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalScopeRegistryRevisionInputV1 {
    pub contract_id: String,
    pub project_id: String,
    pub scope_registry: NarrativeScopeAuthorityRegistryV2,
    pub mappings: Vec<CanonicalScopeRegistryMappingV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalScopeRegistryMappingV1 {
    pub document_ref: String,
    pub source_key: String,
    pub scene_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalReadingOrderRevisionInputV1 {
    pub contract_id: String,
    pub project_id: String,
    pub registry_version: String,
    pub mappings: Vec<CanonicalReadingOrderMappingV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalReadingOrderMappingV1 {
    pub reading_order_ref: String,
    pub scene_ref: String,
    pub reading_rank: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalStoryTimeOrderRevisionInputV1 {
    pub contract_id: String,
    pub project_id: String,
    pub registry_version: String,
    pub mappings: Vec<CanonicalStoryTimeOrderMappingV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalStoryTimeOrderMappingV1 {
    pub story_time_ref: String,
    pub scene_ref: String,
    pub story_time_order: NarrativeScopeAuthorityStoryTimeOrderV2,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalScopeAuthorityDigestInputV2 {
    pub contract_id: String,
    pub basis_kind: String,
    pub project_id: String,
    pub source: NarrativeScopeAuthoritySourceV2,
    pub scope_registry_revision: String,
    pub reading_order_revision: String,
    pub story_time_order_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalNarrativeSourceSnapshotRevisionInputV2 {
    pub contract_id: String,
    pub basis_kind: String,
    pub project_id: String,
    pub source: NarrativeScopeAuthoritySourceV2,
    pub corpus_digest: String,
    pub authority_digest: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum NarrativeScopeAuthorityBasisError {
    #[error("scope authority basis invariant failed: {0}")]
    Invalid(String),
    #[error("scope authority basis canonical JSON failed: {0}")]
    Canonical(String),
}

fn invalid(reason: impl Into<String>) -> NarrativeScopeAuthorityBasisError {
    NarrativeScopeAuthorityBasisError::Invalid(reason.into())
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn is_sha256_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn canonical_digest<T: Serialize>(value: &T) -> Result<String, NarrativeScopeAuthorityBasisError> {
    // This is the sole typed-to-Value bridge. Semantic validation never walks
    // `Value`; the shared canonical JSON primitive owns byte canonicalization.
    let value = serde_json::to_value(value)
        .map_err(|error| NarrativeScopeAuthorityBasisError::Canonical(error.to_string()))?;
    canonical_json_digest(&value)
        .map_err(|error| NarrativeScopeAuthorityBasisError::Canonical(error.to_string()))
}

fn suffix<'a>(
    value: &'a str,
    prefix: &str,
    field: &str,
) -> Result<&'a str, NarrativeScopeAuthorityBasisError> {
    let suffix = value
        .strip_prefix(prefix)
        .ok_or_else(|| invalid(format!("{field} must start with {prefix}")))?;
    if !is_contract_trimmed_non_empty(suffix) {
        return Err(invalid(format!("{field} suffix must be a contract string")));
    }
    Ok(suffix)
}

fn require_contract_string(
    value: &str,
    field: &str,
) -> Result<(), NarrativeScopeAuthorityBasisError> {
    if !is_contract_trimmed_non_empty(value) {
        return Err(invalid(format!(
            "{field} must be a trimmed non-empty contract string"
        )));
    }
    Ok(())
}

fn require_exact(
    value: &str,
    expected: &str,
    field: &str,
) -> Result<(), NarrativeScopeAuthorityBasisError> {
    if value != expected {
        return Err(invalid(format!("{field} must equal {expected}")));
    }
    Ok(())
}

fn insert_unique<'a>(
    set: &mut HashSet<&'a str>,
    value: &'a str,
    field: &str,
) -> Result<(), NarrativeScopeAuthorityBasisError> {
    if !set.insert(value) {
        return Err(invalid(format!("{field} must be unique")));
    }
    Ok(())
}

pub fn canonical_scope_registry_revision_input(
    basis: &NarrativeScopeAuthorityBasisV2,
) -> CanonicalScopeRegistryRevisionInputV1 {
    let mut mappings = basis
        .mappings
        .iter()
        .map(|mapping| CanonicalScopeRegistryMappingV1 {
            document_ref: mapping.document_ref.clone(),
            source_key: mapping.source_key.clone(),
            scene_ref: mapping.scene_ref.clone(),
        })
        .collect::<Vec<_>>();
    mappings.sort_by(|left, right| compare_utf16(&left.scene_ref, &right.scene_ref));
    CanonicalScopeRegistryRevisionInputV1 {
        contract_id: SCOPE_REGISTRY_REVISION_CONTRACT_ID.to_owned(),
        project_id: basis.project_id.clone(),
        scope_registry: basis.scope_registry.clone(),
        mappings,
    }
}

pub fn canonical_reading_order_revision_input(
    basis: &NarrativeScopeAuthorityBasisV2,
) -> CanonicalReadingOrderRevisionInputV1 {
    let mut mappings = basis
        .mappings
        .iter()
        .map(|mapping| CanonicalReadingOrderMappingV1 {
            reading_order_ref: mapping.reading_order_ref.clone(),
            scene_ref: mapping.scene_ref.clone(),
            reading_rank: mapping.reading_rank,
        })
        .collect::<Vec<_>>();
    mappings.sort_by(|left, right| {
        left.reading_rank
            .cmp(&right.reading_rank)
            .then_with(|| compare_utf16(&left.scene_ref, &right.scene_ref))
    });
    CanonicalReadingOrderRevisionInputV1 {
        contract_id: READING_ORDER_REVISION_CONTRACT_ID.to_owned(),
        project_id: basis.project_id.clone(),
        registry_version: basis.scope_registry.registry_version.clone(),
        mappings,
    }
}

pub fn canonical_story_time_order_revision_input(
    basis: &NarrativeScopeAuthorityBasisV2,
) -> CanonicalStoryTimeOrderRevisionInputV1 {
    let mut mappings = basis
        .mappings
        .iter()
        .map(|mapping| CanonicalStoryTimeOrderMappingV1 {
            story_time_ref: mapping.story_time_ref.clone(),
            scene_ref: mapping.scene_ref.clone(),
            story_time_order: mapping.story_time_order.clone(),
        })
        .collect::<Vec<_>>();
    mappings.sort_by(|left, right| compare_utf16(&left.story_time_ref, &right.story_time_ref));
    CanonicalStoryTimeOrderRevisionInputV1 {
        contract_id: STORY_TIME_ORDER_REVISION_CONTRACT_ID.to_owned(),
        project_id: basis.project_id.clone(),
        registry_version: basis.scope_registry.registry_version.clone(),
        mappings,
    }
}

pub fn canonical_scope_authority_digest_input(
    basis: &NarrativeScopeAuthorityBasisV2,
) -> CanonicalScopeAuthorityDigestInputV2 {
    CanonicalScopeAuthorityDigestInputV2 {
        contract_id: SCOPE_AUTHORITY_DIGEST_CONTRACT_ID.to_owned(),
        basis_kind: basis.basis_kind.clone(),
        project_id: basis.project_id.clone(),
        source: basis.source.clone(),
        scope_registry_revision: basis.digests.scope_registry_revision.clone(),
        reading_order_revision: basis.digests.reading_order_revision.clone(),
        story_time_order_revision: basis.digests.story_time_order_revision.clone(),
    }
}

pub fn canonical_narrative_source_snapshot_revision_input(
    basis: &NarrativeScopeAuthorityBasisV2,
) -> CanonicalNarrativeSourceSnapshotRevisionInputV2 {
    CanonicalNarrativeSourceSnapshotRevisionInputV2 {
        contract_id: SOURCE_SNAPSHOT_REVISION_CONTRACT_ID.to_owned(),
        basis_kind: basis.basis_kind.clone(),
        project_id: basis.project_id.clone(),
        source: basis.source.clone(),
        corpus_digest: basis.digests.corpus_digest.clone(),
        authority_digest: basis.digests.authority_digest.clone(),
    }
}

pub fn build_narrative_scope_authority_basis_v2(
    project_id: &str,
    run_id: &str,
    corpus_digest: &str,
    documents: &[NarrativeScopeAuthorityDocumentInputV2],
) -> Result<NarrativeScopeAuthorityBasisV2, NarrativeScopeAuthorityBasisError> {
    require_contract_string(project_id, "projectId")?;
    require_contract_string(run_id, "runId")?;
    if !is_sha256_digest(corpus_digest) {
        return Err(invalid("corpusDigest must be a lowercase sha256 digest"));
    }
    if documents.is_empty() || documents.len() > MAX_DOCUMENT_COUNT {
        return Err(invalid("documents must contain 1..=999999 entries"));
    }

    let mut story_counts = HashMap::<&str, usize>::new();
    for (index, document) in documents.iter().enumerate() {
        let expected_document_ref = format!("D{:06}", index + 1);
        if document.document_ref != expected_document_ref {
            return Err(invalid(format!(
                "documents[{index}].documentRef must equal {expected_document_ref}"
            )));
        }
        suffix(
            &document.source_key,
            PROJECT_SCENE_PREFIX,
            &format!("documents[{index}].sourceKey"),
        )?;
        if let Some(raw_story_key) = document.raw_story_key.as_deref() {
            require_contract_string(raw_story_key, &format!("documents[{index}].rawStoryKey"))?;
            *story_counts.entry(raw_story_key).or_default() += 1;
        }
    }

    let mut unique_story_keys = story_counts
        .iter()
        .filter_map(|(key, count)| (*count == 1).then_some(*key))
        .collect::<Vec<_>>();
    unique_story_keys.sort_by(|left, right| compare_utf16(left, right));
    let story_ranks = unique_story_keys
        .into_iter()
        .enumerate()
        .map(|(rank, key)| (key, rank as u64))
        .collect::<HashMap<_, _>>();

    let mappings = documents
        .iter()
        .enumerate()
        .map(|(index, document)| {
            let node_id = document
                .source_key
                .strip_prefix(PROJECT_SCENE_PREFIX)
                .ok_or_else(|| invalid("document source prefix changed after validation"))?;
            let story_time_order = match document.raw_story_key.as_deref() {
                None => NarrativeScopeAuthorityStoryTimeOrderV2::Unresolved {
                    reason: NarrativeScopeAuthorityUnresolvedReasonV2::NotProvided,
                    raw_story_key: NarrativeScopeAuthorityNullableStoryKeyV2(None),
                },
                Some(raw_story_key)
                    if story_counts.get(raw_story_key).copied().unwrap_or_default() > 1 =>
                {
                    NarrativeScopeAuthorityStoryTimeOrderV2::Unresolved {
                        reason: NarrativeScopeAuthorityUnresolvedReasonV2::Ambiguous,
                        raw_story_key: NarrativeScopeAuthorityNullableStoryKeyV2(Some(
                            raw_story_key.to_owned(),
                        )),
                    }
                }
                Some(raw_story_key) => NarrativeScopeAuthorityStoryTimeOrderV2::Resolved {
                    raw_story_key: raw_story_key.to_owned(),
                    story_rank: story_ranks
                        .get(raw_story_key)
                        .copied()
                        .ok_or_else(|| invalid("unique story key is missing its derived rank"))?,
                },
            };
            Ok(NarrativeScopeAuthorityMappingV2 {
                document_ref: document.document_ref.clone(),
                source_key: document.source_key.clone(),
                scene_ref: format!("{SCENE_REF_PREFIX}{node_id}"),
                reading_order_ref: format!("{READING_REF_PREFIX}{node_id}"),
                story_time_ref: format!("{STORY_REF_PREFIX}{node_id}"),
                reading_rank: index as u64,
                story_time_order,
            })
        })
        .collect::<Result<Vec<_>, NarrativeScopeAuthorityBasisError>>()?;

    let mut basis = NarrativeScopeAuthorityBasisV2 {
        schema_version: NARRATIVE_SCOPE_AUTHORITY_BASIS_SCHEMA_VERSION,
        contract_id: NARRATIVE_SCOPE_AUTHORITY_BASIS_CONTRACT_ID.to_owned(),
        basis_kind: NARRATIVE_SCOPE_AUTHORITY_BASIS_KIND.to_owned(),
        project_id: project_id.to_owned(),
        source: NarrativeScopeAuthoritySourceV2 {
            source_kind: NARRATIVE_SCOPE_AUTHORITY_SOURCE_KIND.to_owned(),
            source_key: format!("{SOURCE_SNAPSHOT_PREFIX}{run_id}"),
        },
        scope_registry: NarrativeScopeAuthorityRegistryV2 {
            registry_version: NARRATIVE_SCOPE_AUTHORITY_REGISTRY_VERSION.to_owned(),
            reserved_audience_refs: vec!["reader".to_owned()],
        },
        mappings,
        digests: NarrativeScopeAuthorityDigestsV2 {
            corpus_digest: corpus_digest.to_owned(),
            scope_registry_revision: String::new(),
            reading_order_revision: String::new(),
            story_time_order_revision: String::new(),
            authority_digest: String::new(),
            composite_digest: String::new(),
        },
    };
    basis.digests.scope_registry_revision =
        canonical_digest(&canonical_scope_registry_revision_input(&basis))?;
    basis.digests.reading_order_revision =
        canonical_digest(&canonical_reading_order_revision_input(&basis))?;
    basis.digests.story_time_order_revision =
        canonical_digest(&canonical_story_time_order_revision_input(&basis))?;
    basis.digests.authority_digest =
        canonical_digest(&canonical_scope_authority_digest_input(&basis))?;
    basis.digests.composite_digest =
        canonical_digest(&canonical_narrative_source_snapshot_revision_input(&basis))?;
    basis.validate()?;
    Ok(basis)
}

impl NarrativeScopeAuthorityBasisV2 {
    pub fn validate(&self) -> Result<(), NarrativeScopeAuthorityBasisError> {
        self.validate_structure()?;

        let scope_registry_revision =
            canonical_digest(&canonical_scope_registry_revision_input(self))?;
        if self.digests.scope_registry_revision != scope_registry_revision {
            return Err(invalid(
                "scopeRegistryRevision does not match its typed projection",
            ));
        }

        let reading_order_revision =
            canonical_digest(&canonical_reading_order_revision_input(self))?;
        if self.digests.reading_order_revision != reading_order_revision {
            return Err(invalid(
                "readingOrderRevision does not match its typed projection",
            ));
        }

        let story_time_order_revision =
            canonical_digest(&canonical_story_time_order_revision_input(self))?;
        if self.digests.story_time_order_revision != story_time_order_revision {
            return Err(invalid(
                "storyTimeOrderRevision does not match its typed projection",
            ));
        }

        let authority_digest = canonical_digest(&canonical_scope_authority_digest_input(self))?;
        if self.digests.authority_digest != authority_digest {
            return Err(invalid(
                "authorityDigest does not match its typed projection",
            ));
        }

        let composite_digest =
            canonical_digest(&canonical_narrative_source_snapshot_revision_input(self))?;
        if self.digests.composite_digest != composite_digest {
            return Err(invalid(
                "compositeDigest does not match its typed projection",
            ));
        }

        Ok(())
    }

    fn validate_structure(&self) -> Result<(), NarrativeScopeAuthorityBasisError> {
        if self.schema_version != NARRATIVE_SCOPE_AUTHORITY_BASIS_SCHEMA_VERSION {
            return Err(invalid("schemaVersion must equal 2"));
        }
        require_exact(
            &self.contract_id,
            NARRATIVE_SCOPE_AUTHORITY_BASIS_CONTRACT_ID,
            "contractId",
        )?;
        require_exact(
            &self.basis_kind,
            NARRATIVE_SCOPE_AUTHORITY_BASIS_KIND,
            "basisKind",
        )?;
        require_contract_string(&self.project_id, "projectId")?;
        require_exact(
            &self.source.source_kind,
            NARRATIVE_SCOPE_AUTHORITY_SOURCE_KIND,
            "source.sourceKind",
        )?;
        suffix(
            &self.source.source_key,
            SOURCE_SNAPSHOT_PREFIX,
            "source.sourceKey",
        )?;
        require_exact(
            &self.scope_registry.registry_version,
            NARRATIVE_SCOPE_AUTHORITY_REGISTRY_VERSION,
            "scopeRegistry.registryVersion",
        )?;
        if self.scope_registry.reserved_audience_refs.as_slice() != ["reader"] {
            return Err(invalid(
                "scopeRegistry.reservedAudienceRefs must equal [reader]",
            ));
        }
        if self.mappings.is_empty() || self.mappings.len() > MAX_DOCUMENT_COUNT {
            return Err(invalid("mappings must contain 1..=999999 documents"));
        }
        self.validate_mappings()?;

        for (field, digest) in [
            ("digests.corpusDigest", &self.digests.corpus_digest),
            (
                "digests.scopeRegistryRevision",
                &self.digests.scope_registry_revision,
            ),
            (
                "digests.readingOrderRevision",
                &self.digests.reading_order_revision,
            ),
            (
                "digests.storyTimeOrderRevision",
                &self.digests.story_time_order_revision,
            ),
            ("digests.authorityDigest", &self.digests.authority_digest),
            ("digests.compositeDigest", &self.digests.composite_digest),
        ] {
            if !is_sha256_digest(digest) {
                return Err(invalid(format!(
                    "{field} must be a lowercase sha256 digest"
                )));
            }
        }
        Ok(())
    }

    fn validate_mappings(&self) -> Result<(), NarrativeScopeAuthorityBasisError> {
        let mut document_refs = HashSet::with_capacity(self.mappings.len());
        let mut source_keys = HashSet::with_capacity(self.mappings.len());
        let mut scene_refs = HashSet::with_capacity(self.mappings.len());
        let mut reading_refs = HashSet::with_capacity(self.mappings.len());
        let mut story_refs = HashSet::with_capacity(self.mappings.len());

        for (index, mapping) in self.mappings.iter().enumerate() {
            let expected_document_ref = format!("D{:06}", index + 1);
            if mapping.document_ref != expected_document_ref {
                return Err(invalid(format!(
                    "mappings[{index}].documentRef must equal {expected_document_ref}"
                )));
            }
            if mapping.reading_rank != index as u64 {
                return Err(invalid(format!(
                    "mappings[{index}].readingRank must equal {index}"
                )));
            }

            let node_id = suffix(
                &mapping.source_key,
                PROJECT_SCENE_PREFIX,
                &format!("mappings[{index}].sourceKey"),
            )?;
            let expected_scene_ref = format!("{SCENE_REF_PREFIX}{node_id}");
            let expected_reading_ref = format!("{READING_REF_PREFIX}{node_id}");
            let expected_story_ref = format!("{STORY_REF_PREFIX}{node_id}");
            if mapping.scene_ref != expected_scene_ref
                || mapping.reading_order_ref != expected_reading_ref
                || mapping.story_time_ref != expected_story_ref
            {
                return Err(invalid(format!(
                    "mappings[{index}] axis refs must share the source node suffix"
                )));
            }

            insert_unique(&mut document_refs, &mapping.document_ref, "documentRef")?;
            insert_unique(&mut source_keys, &mapping.source_key, "sourceKey")?;
            insert_unique(&mut scene_refs, &mapping.scene_ref, "sceneRef")?;
            insert_unique(
                &mut reading_refs,
                &mapping.reading_order_ref,
                "readingOrderRef",
            )?;
            insert_unique(&mut story_refs, &mapping.story_time_ref, "storyTimeRef")?;
        }

        self.validate_story_groups()
    }

    fn validate_story_groups(&self) -> Result<(), NarrativeScopeAuthorityBasisError> {
        #[derive(Clone, Copy)]
        enum StoryEntry {
            Resolved(u64),
            Ambiguous,
        }

        let mut groups: HashMap<&str, Vec<StoryEntry>> = HashMap::new();
        for (index, mapping) in self.mappings.iter().enumerate() {
            match &mapping.story_time_order {
                NarrativeScopeAuthorityStoryTimeOrderV2::Resolved {
                    raw_story_key,
                    story_rank,
                } => {
                    require_contract_string(
                        raw_story_key,
                        &format!("mappings[{index}].storyTimeOrder.rawStoryKey"),
                    )?;
                    groups
                        .entry(raw_story_key)
                        .or_default()
                        .push(StoryEntry::Resolved(*story_rank));
                }
                NarrativeScopeAuthorityStoryTimeOrderV2::Unresolved {
                    reason: NarrativeScopeAuthorityUnresolvedReasonV2::NotProvided,
                    raw_story_key,
                } => {
                    if raw_story_key.as_deref().is_some() {
                        return Err(invalid(format!(
                            "mappings[{index}] not-provided story order requires null rawStoryKey"
                        )));
                    }
                }
                NarrativeScopeAuthorityStoryTimeOrderV2::Unresolved {
                    reason: NarrativeScopeAuthorityUnresolvedReasonV2::Ambiguous,
                    raw_story_key,
                } => {
                    let raw_story_key = raw_story_key.as_deref().ok_or_else(|| {
                        invalid(format!(
                            "mappings[{index}] ambiguous story order requires rawStoryKey"
                        ))
                    })?;
                    require_contract_string(
                        raw_story_key,
                        &format!("mappings[{index}].storyTimeOrder.rawStoryKey"),
                    )?;
                    groups
                        .entry(raw_story_key)
                        .or_default()
                        .push(StoryEntry::Ambiguous);
                }
            }
        }

        let mut resolved = Vec::new();
        for (raw_story_key, entries) in groups {
            match entries.as_slice() {
                [StoryEntry::Resolved(story_rank)] => {
                    resolved.push((raw_story_key, *story_rank));
                }
                entries
                    if entries.len() > 1
                        && entries
                            .iter()
                            .all(|entry| matches!(entry, StoryEntry::Ambiguous)) => {}
                _ => {
                    return Err(invalid(
                        "each unique story key must be resolved and each duplicate key ambiguous",
                    ));
                }
            }
        }

        resolved.sort_by(|left, right| compare_utf16(left.0, right.0));
        for (expected_rank, (_, story_rank)) in resolved.into_iter().enumerate() {
            if story_rank != expected_rank as u64 {
                return Err(invalid(
                    "resolved storyRank values must follow UTF-16 key order contiguously",
                ));
            }
        }
        Ok(())
    }

    pub fn validate_trusted_context(
        &self,
        trusted: &NarrativeScopeAuthorityTrustedContextV2,
    ) -> Result<(), NarrativeScopeAuthorityBasisError> {
        self.validate()?;
        if trusted.project_id != self.project_id {
            return Err(invalid("trusted projectId does not match basis projectId"));
        }
        if trusted.source_key != self.source.source_key {
            return Err(invalid("trusted sourceKey does not match basis sourceKey"));
        }
        if trusted.expected_composite_digest != self.digests.composite_digest {
            return Err(invalid(
                "trusted expectedCompositeDigest does not match basis compositeDigest",
            ));
        }
        require_contract_string(&trusted.project_id, "trusted.projectId")?;
        suffix(
            &trusted.source_key,
            SOURCE_SNAPSHOT_PREFIX,
            "trusted.sourceKey",
        )?;
        if trusted.documents.len() != self.mappings.len() {
            return Err(invalid("trusted documents do not exactly cover mappings"));
        }

        let mut documents_by_ref = HashMap::with_capacity(trusted.documents.len());
        for document in &trusted.documents {
            require_contract_string(&document.node_id, "trusted.documents[].nodeId")?;
            if document.project_id != trusted.project_id {
                return Err(invalid("trusted document projectId does not match context"));
            }
            let expected_source_key = format!("{PROJECT_SCENE_PREFIX}{}", document.node_id);
            if document.source_key != expected_source_key {
                return Err(invalid("trusted document sourceKey does not match nodeId"));
            }
            if documents_by_ref
                .insert(document.document_ref.as_str(), document)
                .is_some()
            {
                return Err(invalid("trusted documentRef values must be unique"));
            }
        }

        for mapping in &self.mappings {
            let document = documents_by_ref
                .get(mapping.document_ref.as_str())
                .ok_or_else(|| invalid("trusted documentRef coverage is incomplete"))?;
            let node_id = suffix(
                &mapping.source_key,
                PROJECT_SCENE_PREFIX,
                "mapping.sourceKey",
            )?;
            if document.source_key != mapping.source_key
                || document.node_id != node_id
                || document.project_id != self.project_id
            {
                return Err(invalid("trusted document identity does not match mapping"));
            }
        }
        Ok(())
    }
}
