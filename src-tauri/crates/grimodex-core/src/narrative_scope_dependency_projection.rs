//! Necessary Scope-resolution inputs. The project authority is an input to
//! verification, never itself part of a non-secret dependency digest.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

use crate::canonical_json_digest;
use crate::narrative_project_scope_authority::{
    NarrativeProjectScopeAuthorityMappingV1, NarrativeProjectScopeAuthorityV1,
};

pub const SOURCE_KIND: &str = "scope-dependency-projection-v1";
pub const SOURCE_PREFIX: &str = "scope-dependency:v1:";
pub const CONTRACT_ID: &str = "narrative-scope-dependency-projection/1";

/// Native resolves both document identities against the same sealed Run
/// before calling this pure projection. The key is self describing so no
/// additional mutable lookup table can redirect a persisted dependency.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeDependencyIdentity {
    pub project_id: String,
    pub run_id: String,
    pub anchor_document_ref: String,
    pub anchor_scene_ref: String,
    pub reveal_document_ref: String,
    pub reveal_scene_ref: String,
    pub secret: bool,
}

#[derive(Debug, Error)]
#[error("NEX_SCOPE_DEPENDENCY_INVALID: {0}")]
pub struct ScopeDependencyError(String);

type Result<T> = std::result::Result<T, ScopeDependencyError>;

impl ScopeDependencyIdentity {
    fn validate(&self) -> Result<()> {
        for value in [
            &self.project_id,
            &self.run_id,
            &self.anchor_document_ref,
            &self.anchor_scene_ref,
            &self.reveal_document_ref,
            &self.reveal_scene_ref,
        ] {
            if value.is_empty() || value.trim() != value || value.len() > 4096 {
                return Err(ScopeDependencyError("invalid identity field".into()));
            }
        }
        for value in [&self.anchor_scene_ref, &self.reveal_scene_ref] {
            if !value.starts_with("scene:") || value.len() == 6 {
                return Err(ScopeDependencyError("invalid scene reference".into()));
            }
        }
        Ok(())
    }

    pub fn source_key(&self) -> Result<String> {
        self.validate()?;
        let serialized =
            serde_json::to_vec(self).map_err(|e| ScopeDependencyError(e.to_string()))?;
        let encoded = serialized
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        Ok(format!("{SOURCE_PREFIX}{encoded}"))
    }

    pub fn from_source_key(key: &str) -> Result<Self> {
        let encoded = key
            .strip_prefix(SOURCE_PREFIX)
            .filter(|s| !s.is_empty() && s.len() <= 65536 && s.len() % 2 == 0)
            .ok_or_else(|| ScopeDependencyError("invalid Source key".into()))?;
        let bytes = encoded
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                let text =
                    std::str::from_utf8(pair).map_err(|e| ScopeDependencyError(e.to_string()))?;
                u8::from_str_radix(text, 16).map_err(|e| ScopeDependencyError(e.to_string()))
            })
            .collect::<Result<Vec<_>>>()?;
        let identity: Self =
            serde_json::from_slice(&bytes).map_err(|e| ScopeDependencyError(e.to_string()))?;
        if identity.source_key()? != key {
            return Err(ScopeDependencyError("noncanonical Source key".into()));
        }
        Ok(identity)
    }
}

fn unique_mapping<'a>(
    authority: &'a NarrativeProjectScopeAuthorityV1,
    scene: &str,
) -> Result<&'a NarrativeProjectScopeAuthorityMappingV1> {
    let mut matching = authority.mappings.iter().filter(|m| m.scene_ref == scene);
    let mapping = matching
        .next()
        .ok_or_else(|| ScopeDependencyError("reference unavailable".into()))?;
    if matching.next().is_some() || mapping.source_key != format!("project:{scene}") {
        return Err(ScopeDependencyError(
            "reference ambiguous or inconsistent".into(),
        ));
    }
    Ok(mapping)
}

pub fn projection_revision(
    identity: &ScopeDependencyIdentity,
    authority: &NarrativeProjectScopeAuthorityV1,
) -> Result<String> {
    identity.validate()?;
    if authority.project_id != identity.project_id {
        return Err(ScopeDependencyError("project mismatch".into()));
    }
    let anchor = unique_mapping(authority, &identity.anchor_scene_ref)?;
    let reveal = unique_mapping(authority, &identity.reveal_scene_ref)?;
    // Membership/identity validity is checked above even for non-secret Scope.
    // Reading ranks, story keys and aggregate revisions are unused there.
    let required: Value = if identity.secret {
        if authority
            .scope_registry
            .reserved_audience_refs
            .iter()
            .filter(|r| r.as_str() == "reader")
            .count()
            != 1
        {
            return Err(ScopeDependencyError("reader audience unavailable".into()));
        }
        json!({"audience":"reader", "readingOrderRef":reveal.reading_order_ref,
            "readingRank":reveal.reading_rank, "storyTimeRef":reveal.story_time_ref,
            "storyTimeOrder":reveal.story_time_order})
    } else {
        json!({"otherAxes":"any"})
    };
    canonical_json_digest(&json!({"contractId":CONTRACT_ID, "identity":identity,
        "registryVersion":authority.scope_registry.registry_version,
        "anchorSource":anchor.source_key,"revealSource":reveal.source_key,"required":required}))
    .map_err(|e| ScopeDependencyError(e.to_string()))
}
