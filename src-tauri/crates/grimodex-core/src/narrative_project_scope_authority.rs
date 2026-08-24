//! Typed live-project Scope/Order authority.
//!
//! Callers supply only live, non-archived scenes in persisted Reading DFS
//! order. Tree traversal, SQL, prose, display metadata, and Chronicle data stay
//! outside this digest boundary. Core derives the registry, Reading, and Story
//! axes independently and composes their canonical revisions into one stable
//! project-scoped Source revision.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::Serialize;
use thiserror::Error;

use crate::canonical_json::canonical_json_digest;
use crate::contract_string::is_contract_trimmed_non_empty;
use crate::narrative_scope_authority_basis::{
    NarrativeScopeAuthorityRegistryV2, NarrativeScopeAuthorityStoryTimeOrderV2,
    NARRATIVE_SCOPE_AUTHORITY_REGISTRY_VERSION,
};

pub const NARRATIVE_PROJECT_SCOPE_AUTHORITY_SOURCE_KIND: &str = "project-scope-authority";
pub const NARRATIVE_PROJECT_SCOPE_AUTHORITY_REVISION_CONTRACT_ID: &str =
    "narrative-project-scope-authority-revision/1";

const SCOPE_REGISTRY_REVISION_CONTRACT_ID: &str = "narrative-scope-registry-revision/1";
const READING_ORDER_REVISION_CONTRACT_ID: &str = "narrative-reading-order-revision/1";
const STORY_TIME_ORDER_REVISION_CONTRACT_ID: &str = "narrative-story-time-order-revision/1";
const PROJECT_SCOPE_AUTHORITY_PREFIX: &str = "project:scope-authority:";
const PROJECT_SCENE_PREFIX: &str = "project:scene:";
const SCENE_REF_PREFIX: &str = "scene:";
const READING_REF_PREFIX: &str = "reading:";
const STORY_REF_PREFIX: &str = "story:";

/// One live, non-archived Scene in persisted Reading DFS order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NarrativeProjectScopeAuthoritySceneInputV1 {
    pub scene_id: String,
    pub raw_story_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeProjectScopeAuthorityV1 {
    pub project_id: String,
    pub source: NarrativeProjectScopeAuthoritySourceV1,
    pub scope_registry: NarrativeScopeAuthorityRegistryV2,
    pub mappings: Vec<NarrativeProjectScopeAuthorityMappingV1>,
    pub digests: NarrativeProjectScopeAuthorityDigestsV1,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeProjectScopeAuthoritySourceV1 {
    pub source_kind: String,
    pub source_key: String,
    pub revision_token: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeProjectScopeAuthorityMappingV1 {
    pub source_key: String,
    pub scene_ref: String,
    pub reading_order_ref: String,
    pub story_time_ref: String,
    pub reading_rank: u64,
    pub story_time_order: NarrativeScopeAuthorityStoryTimeOrderV2,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeProjectScopeAuthorityDigestsV1 {
    pub scope_registry_revision: String,
    pub reading_order_revision: String,
    pub story_time_order_revision: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalProjectScopeRegistryRevisionInputV1 {
    pub contract_id: String,
    pub project_id: String,
    pub scope_registry: NarrativeScopeAuthorityRegistryV2,
    pub mappings: Vec<CanonicalProjectScopeRegistryMappingV1>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalProjectScopeRegistryMappingV1 {
    pub source_key: String,
    pub scene_ref: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalProjectReadingOrderRevisionInputV1 {
    pub contract_id: String,
    pub project_id: String,
    pub registry_version: String,
    pub mappings: Vec<CanonicalProjectReadingOrderMappingV1>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalProjectReadingOrderMappingV1 {
    pub reading_order_ref: String,
    pub scene_ref: String,
    pub reading_rank: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalProjectStoryTimeOrderRevisionInputV1 {
    pub contract_id: String,
    pub project_id: String,
    pub registry_version: String,
    pub mappings: Vec<CanonicalProjectStoryTimeOrderMappingV1>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalProjectStoryTimeOrderMappingV1 {
    pub story_time_ref: String,
    pub scene_ref: String,
    pub story_time_order: NarrativeScopeAuthorityStoryTimeOrderV2,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalProjectScopeAuthorityRevisionInputV1 {
    pub contract_id: String,
    pub project_id: String,
    pub source: NarrativeProjectScopeAuthoritySourceIdentityV1,
    pub scope_registry_revision: String,
    pub reading_order_revision: String,
    pub story_time_order_revision: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeProjectScopeAuthoritySourceIdentityV1 {
    pub source_kind: String,
    pub source_key: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum NarrativeProjectScopeAuthorityError {
    #[error("project scope authority invariant failed: {0}")]
    Invalid(String),
    #[error("project scope authority canonical JSON failed: {0}")]
    Canonical(String),
}

fn invalid(reason: impl Into<String>) -> NarrativeProjectScopeAuthorityError {
    NarrativeProjectScopeAuthorityError::Invalid(reason.into())
}

fn require_contract_string(
    value: &str,
    field: &str,
) -> Result<(), NarrativeProjectScopeAuthorityError> {
    if !is_contract_trimmed_non_empty(value) {
        return Err(invalid(format!(
            "{field} must be a trimmed non-empty contract string"
        )));
    }
    Ok(())
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn canonical_digest<T: Serialize>(
    value: &T,
) -> Result<String, NarrativeProjectScopeAuthorityError> {
    // The shared canonical JSON primitive is the sole typed-to-Value bridge;
    // this module never interprets or walks an open JSON value.
    let value = serde_json::to_value(value)
        .map_err(|error| NarrativeProjectScopeAuthorityError::Canonical(error.to_string()))?;
    canonical_json_digest(&value)
        .map_err(|error| NarrativeProjectScopeAuthorityError::Canonical(error.to_string()))
}

pub fn canonical_project_scope_registry_revision_input(
    authority: &NarrativeProjectScopeAuthorityV1,
) -> CanonicalProjectScopeRegistryRevisionInputV1 {
    let mut mappings = authority
        .mappings
        .iter()
        .map(|mapping| CanonicalProjectScopeRegistryMappingV1 {
            source_key: mapping.source_key.clone(),
            scene_ref: mapping.scene_ref.clone(),
        })
        .collect::<Vec<_>>();
    mappings.sort_by(|left, right| compare_utf16(&left.scene_ref, &right.scene_ref));

    CanonicalProjectScopeRegistryRevisionInputV1 {
        contract_id: SCOPE_REGISTRY_REVISION_CONTRACT_ID.to_owned(),
        project_id: authority.project_id.clone(),
        scope_registry: authority.scope_registry.clone(),
        mappings,
    }
}

pub fn canonical_project_reading_order_revision_input(
    authority: &NarrativeProjectScopeAuthorityV1,
) -> CanonicalProjectReadingOrderRevisionInputV1 {
    let mut mappings = authority
        .mappings
        .iter()
        .map(|mapping| CanonicalProjectReadingOrderMappingV1 {
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

    CanonicalProjectReadingOrderRevisionInputV1 {
        contract_id: READING_ORDER_REVISION_CONTRACT_ID.to_owned(),
        project_id: authority.project_id.clone(),
        registry_version: authority.scope_registry.registry_version.clone(),
        mappings,
    }
}

pub fn canonical_project_story_time_order_revision_input(
    authority: &NarrativeProjectScopeAuthorityV1,
) -> CanonicalProjectStoryTimeOrderRevisionInputV1 {
    let mut mappings = authority
        .mappings
        .iter()
        .map(|mapping| CanonicalProjectStoryTimeOrderMappingV1 {
            story_time_ref: mapping.story_time_ref.clone(),
            scene_ref: mapping.scene_ref.clone(),
            story_time_order: mapping.story_time_order.clone(),
        })
        .collect::<Vec<_>>();
    mappings.sort_by(|left, right| compare_utf16(&left.story_time_ref, &right.story_time_ref));

    CanonicalProjectStoryTimeOrderRevisionInputV1 {
        contract_id: STORY_TIME_ORDER_REVISION_CONTRACT_ID.to_owned(),
        project_id: authority.project_id.clone(),
        registry_version: authority.scope_registry.registry_version.clone(),
        mappings,
    }
}

pub fn canonical_project_scope_authority_revision_input(
    authority: &NarrativeProjectScopeAuthorityV1,
) -> CanonicalProjectScopeAuthorityRevisionInputV1 {
    CanonicalProjectScopeAuthorityRevisionInputV1 {
        contract_id: NARRATIVE_PROJECT_SCOPE_AUTHORITY_REVISION_CONTRACT_ID.to_owned(),
        project_id: authority.project_id.clone(),
        source: NarrativeProjectScopeAuthoritySourceIdentityV1 {
            source_kind: authority.source.source_kind.clone(),
            source_key: authority.source.source_key.clone(),
        },
        scope_registry_revision: authority.digests.scope_registry_revision.clone(),
        reading_order_revision: authority.digests.reading_order_revision.clone(),
        story_time_order_revision: authority.digests.story_time_order_revision.clone(),
    }
}

pub fn build_narrative_project_scope_authority_v1(
    project_id: &str,
    scenes: &[NarrativeProjectScopeAuthoritySceneInputV1],
) -> Result<NarrativeProjectScopeAuthorityV1, NarrativeProjectScopeAuthorityError> {
    require_contract_string(project_id, "projectId")?;

    let mut scene_ids = HashSet::with_capacity(scenes.len());
    let mut story_counts = HashMap::<&str, usize>::new();
    for (index, scene) in scenes.iter().enumerate() {
        require_contract_string(&scene.scene_id, &format!("scenes[{index}].sceneId"))?;
        if !scene_ids.insert(scene.scene_id.as_str()) {
            return Err(invalid("sceneId values must be unique"));
        }
        if let Some(raw_story_key) = scene.raw_story_key.as_deref() {
            require_contract_string(raw_story_key, &format!("scenes[{index}].rawStoryKey"))?;
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
        .map(|(rank, key)| {
            u64::try_from(rank)
                .map(|rank| (key, rank))
                .map_err(|_| invalid("Story rank exceeds the u64 contract"))
        })
        .collect::<Result<HashMap<_, _>, _>>()?;

    let mappings = scenes
        .iter()
        .enumerate()
        .map(|(index, scene)| {
            let reading_rank = u64::try_from(index)
                .map_err(|_| invalid("Reading rank exceeds the u64 contract"))?;
            let story_time_order = match scene.raw_story_key.as_deref() {
                None => NarrativeScopeAuthorityStoryTimeOrderV2::unresolved_not_provided(),
                Some(raw_story_key)
                    if story_counts.get(raw_story_key).copied().unwrap_or_default() > 1 =>
                {
                    NarrativeScopeAuthorityStoryTimeOrderV2::unresolved_ambiguous(
                        raw_story_key.to_owned(),
                    )
                }
                Some(raw_story_key) => NarrativeScopeAuthorityStoryTimeOrderV2::Resolved {
                    raw_story_key: raw_story_key.to_owned(),
                    story_rank: story_ranks
                        .get(raw_story_key)
                        .copied()
                        .ok_or_else(|| invalid("unique story key is missing its derived rank"))?,
                },
            };

            Ok(NarrativeProjectScopeAuthorityMappingV1 {
                source_key: format!("{PROJECT_SCENE_PREFIX}{}", scene.scene_id),
                scene_ref: format!("{SCENE_REF_PREFIX}{}", scene.scene_id),
                reading_order_ref: format!("{READING_REF_PREFIX}{}", scene.scene_id),
                story_time_ref: format!("{STORY_REF_PREFIX}{}", scene.scene_id),
                reading_rank,
                story_time_order,
            })
        })
        .collect::<Result<Vec<_>, NarrativeProjectScopeAuthorityError>>()?;

    let mut authority = NarrativeProjectScopeAuthorityV1 {
        project_id: project_id.to_owned(),
        source: NarrativeProjectScopeAuthoritySourceV1 {
            source_kind: NARRATIVE_PROJECT_SCOPE_AUTHORITY_SOURCE_KIND.to_owned(),
            source_key: format!("{PROJECT_SCOPE_AUTHORITY_PREFIX}{project_id}"),
            revision_token: String::new(),
        },
        scope_registry: NarrativeScopeAuthorityRegistryV2 {
            registry_version: NARRATIVE_SCOPE_AUTHORITY_REGISTRY_VERSION.to_owned(),
            reserved_audience_refs: vec!["reader".to_owned()],
        },
        mappings,
        digests: NarrativeProjectScopeAuthorityDigestsV1 {
            scope_registry_revision: String::new(),
            reading_order_revision: String::new(),
            story_time_order_revision: String::new(),
        },
    };

    authority.digests.scope_registry_revision =
        canonical_digest(&canonical_project_scope_registry_revision_input(&authority))?;
    authority.digests.reading_order_revision =
        canonical_digest(&canonical_project_reading_order_revision_input(&authority))?;
    authority.digests.story_time_order_revision = canonical_digest(
        &canonical_project_story_time_order_revision_input(&authority),
    )?;
    authority.source.revision_token = canonical_digest(
        &canonical_project_scope_authority_revision_input(&authority),
    )?;

    Ok(authority)
}
