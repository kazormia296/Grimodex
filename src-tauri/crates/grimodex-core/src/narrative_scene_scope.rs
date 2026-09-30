//! Typed, Native-owned scene scope state for the NIR-1 A1 slice.
//!
//! The project tree and the existing project scope authority remain the
//! source of scene membership/order. This module only defines the small
//! per-scene extension used to bind a scene to explicit query/material scope
//! axes, an incarnation, and holder/audience principals. It deliberately
//! does not contain prose or a second material store.

use serde::{Deserialize, Serialize};

use crate::canonical_json::canonical_json_digest;
use crate::contract_string::is_contract_trimmed_non_empty;

pub const NARRATIVE_SCENE_SCOPE_CONTRACT_ID: &str = "narrative-scene-scope/1";
pub const NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID: &str = "narrative-scene-scope-registry/1";
pub const NARRATIVE_SCENE_SCOPE_SOURCE_KIND: &str = "scene-scope-authority";

/// A closed scope vocabulary. Any is valid for a material constraint, but a
/// query identity must be concrete or explicitly unresolved.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum NarrativeScopeConstraintV1 {
    #[serde(rename = "any")]
    Any,
    #[serde(rename = "exact")]
    Exact {
        #[serde(rename = "ref")]
        reference: String,
    },
    #[serde(rename = "unresolved")]
    Unresolved { reason: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NarrativeScopeCompatibilityMarkerV1 {
    LegacyAbsent,
    Explicit,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSceneScopeRegistryV1 {
    pub registry_version: String,
    #[serde(default)]
    pub timeline_refs: Vec<String>,
    #[serde(default)]
    pub worldline_refs: Vec<String>,
    #[serde(default)]
    pub narrative_layer_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSceneQueryIdentityV1 {
    pub timeline: NarrativeScopeConstraintV1,
    pub worldline: NarrativeScopeConstraintV1,
    pub narrative_layer: NarrativeScopeConstraintV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSceneMaterialConstraintV1 {
    pub timeline: NarrativeScopeConstraintV1,
    pub worldline: NarrativeScopeConstraintV1,
    pub narrative_layer: NarrativeScopeConstraintV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum NarrativeScopePrincipalV1 {
    #[serde(rename = "reader")]
    Reader {},
    #[serde(rename = "character")]
    Character {
        #[serde(rename = "ref")]
        reference: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSceneScopeBindingV1 {
    pub schema_version: u32,
    pub project_id: String,
    pub scene_id: String,
    pub scene_incarnation_id: String,
    pub compatibility_marker: NarrativeScopeCompatibilityMarkerV1,
    pub query_identity: NarrativeSceneQueryIdentityV1,
    pub material_constraint: NarrativeSceneMaterialConstraintV1,
    pub knowledge_holder: NarrativeScopePrincipalV1,
    pub audience: NarrativeScopePrincipalV1,
    pub version: i64,
    pub source_token: String,
    pub updated_at: String,
}

pub fn validate_registry(registry: &NarrativeSceneScopeRegistryV1) -> anyhow::Result<()> {
    anyhow::ensure!(
        registry.registry_version == NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
        "unsupported scene scope registry version"
    );
    require_contract_string(&registry.registry_version, "registryVersion")?;
    for (name, refs) in [
        ("timelineRefs", &registry.timeline_refs),
        ("worldlineRefs", &registry.worldline_refs),
        ("narrativeLayerRefs", &registry.narrative_layer_refs),
    ] {
        let mut seen = std::collections::BTreeSet::new();
        for reference in refs {
            require_contract_string(reference, name)?;
            anyhow::ensure!(
                seen.insert(reference),
                "{name} must not contain duplicate references"
            );
        }
    }
    Ok(())
}

pub fn validate_binding(
    binding: &NarrativeSceneScopeBindingV1,
    registry: &NarrativeSceneScopeRegistryV1,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        binding.schema_version == 1,
        "unsupported scene scope schemaVersion"
    );
    for (value, field) in [
        (&binding.project_id, "projectId"),
        (&binding.scene_id, "sceneId"),
        (&binding.scene_incarnation_id, "sceneIncarnationId"),
        (&binding.source_token, "sourceToken"),
        (&binding.updated_at, "updatedAt"),
    ] {
        require_contract_string(value, field)?;
    }
    anyhow::ensure!(binding.version >= 1, "scene scope version must be positive");
    validate_registry(registry)?;
    validate_principal(&binding.knowledge_holder, "knowledgeHolder")?;
    validate_principal(&binding.audience, "audience")?;
    validate_query_identity(&binding.query_identity, registry)?;
    validate_material_constraint(&binding.material_constraint, registry)?;

    if binding.compatibility_marker == NarrativeScopeCompatibilityMarkerV1::LegacyAbsent {
        anyhow::ensure!(
            binding.knowledge_holder == NarrativeScopePrincipalV1::Reader {}
                && binding.audience == NarrativeScopePrincipalV1::Reader {},
            "legacy-absent scope must use the reader holder and audience"
        );
        anyhow::ensure!(
            is_unresolved(&binding.query_identity.timeline)
                && is_unresolved(&binding.query_identity.worldline)
                && is_unresolved(&binding.query_identity.narrative_layer),
            "legacy-absent scope must leave extension query identity unresolved"
        );
        anyhow::ensure!(
            is_any(&binding.material_constraint.timeline)
                && is_any(&binding.material_constraint.worldline)
                && is_any(&binding.material_constraint.narrative_layer),
            "legacy-absent scope must not carry explicit material constraints"
        );
    }
    if binding.compatibility_marker == NarrativeScopeCompatibilityMarkerV1::Unknown {
        anyhow::ensure!(
            is_unresolved(&binding.query_identity.timeline)
                && is_unresolved(&binding.query_identity.worldline)
                && is_unresolved(&binding.query_identity.narrative_layer),
            "unknown scope must leave extension query identity unresolved"
        );
    }
    Ok(())
}

pub fn source_token(
    registry: &NarrativeSceneScopeRegistryV1,
    binding: &NarrativeSceneScopeBindingV1,
) -> anyhow::Result<String> {
    validate_registry(registry)?;
    // sourceToken is excluded to avoid a self-reference. The incarnation,
    // OCC version, marker, identities, constraints, principals, and the
    // latest canonical source timestamp are all part of the source state.
    let value = serde_json::json!({
        "contractId": NARRATIVE_SCENE_SCOPE_CONTRACT_ID,
        "registry": registry,
        "projectId": binding.project_id,
        "sceneId": binding.scene_id,
        "sceneIncarnationId": binding.scene_incarnation_id,
        "compatibilityMarker": binding.compatibility_marker,
        "queryIdentity": binding.query_identity,
        "materialConstraint": binding.material_constraint,
        "knowledgeHolder": binding.knowledge_holder,
        "audience": binding.audience,
        "version": binding.version,
        "updatedAt": binding.updated_at,
    });
    canonical_json_digest(&value).map_err(Into::into)
}

pub fn is_unresolved(constraint: &NarrativeScopeConstraintV1) -> bool {
    matches!(constraint, NarrativeScopeConstraintV1::Unresolved { .. })
}

fn is_any(constraint: &NarrativeScopeConstraintV1) -> bool {
    matches!(constraint, NarrativeScopeConstraintV1::Any)
}

fn validate_query_identity(
    identity: &NarrativeSceneQueryIdentityV1,
    registry: &NarrativeSceneScopeRegistryV1,
) -> anyhow::Result<()> {
    for (name, constraint, allowed) in [
        ("timeline", &identity.timeline, &registry.timeline_refs),
        ("worldline", &identity.worldline, &registry.worldline_refs),
        (
            "narrativeLayer",
            &identity.narrative_layer,
            &registry.narrative_layer_refs,
        ),
    ] {
        anyhow::ensure!(
            !matches!(constraint, NarrativeScopeConstraintV1::Any),
            "queryIdentity.{name} cannot be any"
        );
        validate_constraint(constraint, &format!("queryIdentity.{name}"))?;
        if let NarrativeScopeConstraintV1::Exact { reference } = constraint {
            anyhow::ensure!(
                allowed.iter().any(|candidate| candidate == reference),
                "queryIdentity.{name} references an unregistered value"
            );
        }
    }
    Ok(())
}

fn validate_material_constraint(
    constraint: &NarrativeSceneMaterialConstraintV1,
    registry: &NarrativeSceneScopeRegistryV1,
) -> anyhow::Result<()> {
    for (name, value, allowed) in [
        ("timeline", &constraint.timeline, &registry.timeline_refs),
        ("worldline", &constraint.worldline, &registry.worldline_refs),
        (
            "narrativeLayer",
            &constraint.narrative_layer,
            &registry.narrative_layer_refs,
        ),
    ] {
        validate_constraint(value, &format!("materialConstraint.{name}"))?;
        if let NarrativeScopeConstraintV1::Exact { reference } = value {
            anyhow::ensure!(
                allowed.iter().any(|candidate| candidate == reference),
                "materialConstraint.{name} references an unregistered value"
            );
        }
    }
    Ok(())
}

fn validate_constraint(constraint: &NarrativeScopeConstraintV1, field: &str) -> anyhow::Result<()> {
    match constraint {
        NarrativeScopeConstraintV1::Any => Ok(()),
        NarrativeScopeConstraintV1::Exact { reference } => {
            require_contract_string(reference, &format!("{field}.ref"))
        }
        NarrativeScopeConstraintV1::Unresolved { reason } => {
            require_contract_string(reason, &format!("{field}.reason"))
        }
    }
}

fn validate_principal(principal: &NarrativeScopePrincipalV1, field: &str) -> anyhow::Result<()> {
    if let NarrativeScopePrincipalV1::Character { reference } = principal {
        require_contract_string(reference, &format!("{field}.ref"))?;
    }
    Ok(())
}

fn require_contract_string(value: &str, field: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        is_contract_trimmed_non_empty(value),
        "{field} must be a trimmed non-empty contract string"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> NarrativeSceneScopeRegistryV1 {
        NarrativeSceneScopeRegistryV1 {
            registry_version: NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID.into(),
            timeline_refs: vec!["timeline:main".into()],
            worldline_refs: vec!["worldline:prime".into()],
            narrative_layer_refs: vec!["layer:manuscript".into()],
        }
    }

    fn binding() -> NarrativeSceneScopeBindingV1 {
        NarrativeSceneScopeBindingV1 {
            schema_version: 1,
            project_id: "p1".into(),
            scene_id: "s1".into(),
            scene_incarnation_id: "inc-1".into(),
            compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
            query_identity: NarrativeSceneQueryIdentityV1 {
                timeline: NarrativeScopeConstraintV1::Exact {
                    reference: "timeline:main".into(),
                },
                worldline: NarrativeScopeConstraintV1::Exact {
                    reference: "worldline:prime".into(),
                },
                narrative_layer: NarrativeScopeConstraintV1::Exact {
                    reference: "layer:manuscript".into(),
                },
            },
            material_constraint: NarrativeSceneMaterialConstraintV1 {
                timeline: NarrativeScopeConstraintV1::Any,
                worldline: NarrativeScopeConstraintV1::Any,
                narrative_layer: NarrativeScopeConstraintV1::Any,
            },
            knowledge_holder: NarrativeScopePrincipalV1::Reader {},
            audience: NarrativeScopePrincipalV1::Reader {},
            version: 1,
            source_token: "placeholder".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn explicit_binding_is_strict_and_digest_changes_on_incarnation() {
        let registry = registry();
        let mut value = binding();
        validate_binding(&value, &registry).expect("valid binding");
        let first = source_token(&registry, &value).expect("digest");
        value.scene_incarnation_id = "inc-2".into();
        let second = source_token(&registry, &value).expect("digest");
        assert_ne!(first, second);
    }

    #[test]
    fn query_identity_rejects_any() {
        let registry = registry();
        let mut value = binding();
        value.query_identity.timeline = NarrativeScopeConstraintV1::Any;
        assert!(validate_binding(&value, &registry).is_err());
    }

    #[test]
    fn registry_version_is_closed() {
        let mut value = registry();
        value.registry_version = "narrative-scene-scope-registry/2".into();
        assert!(validate_registry(&value).is_err());
    }

    #[test]
    fn nested_scope_values_reject_unknown_fields() {
        assert!(serde_json::from_str::<NarrativeScopeConstraintV1>(
            r#"{"kind":"exact","ref":"timeline:main","extra":true}"#,
        )
        .is_err());
        assert!(serde_json::from_str::<NarrativeScopePrincipalV1>(
            r#"{"kind":"reader","extra":true}"#,
        )
        .is_err());
    }

    #[test]
    fn legacy_binding_rejects_explicit_material_constraints() {
        let registry = registry();
        let mut value = binding();
        value.compatibility_marker = NarrativeScopeCompatibilityMarkerV1::LegacyAbsent;
        value.query_identity = NarrativeSceneQueryIdentityV1 {
            timeline: NarrativeScopeConstraintV1::Unresolved {
                reason: "legacy".into(),
            },
            worldline: NarrativeScopeConstraintV1::Unresolved {
                reason: "legacy".into(),
            },
            narrative_layer: NarrativeScopeConstraintV1::Unresolved {
                reason: "legacy".into(),
            },
        };
        value.knowledge_holder = NarrativeScopePrincipalV1::Reader {};
        value.audience = NarrativeScopePrincipalV1::Reader {};
        value.material_constraint.timeline = NarrativeScopeConstraintV1::Exact {
            reference: "timeline:main".into(),
        };
        assert!(validate_binding(&value, &registry).is_err());
    }
}
