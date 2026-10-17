//! Closed, Native-owned type for an author's whole-body disclosure declaration
//! of one Scene (Scene Scope v2, `nir1-c-body-disclosure-proposal/4`
//! `scope-storage-authority`).
//!
//! A declaration is stored in two nullable columns of the Scene's existing
//! scope binding row: its canonical JSON and its token. This module only
//! defines the closed JSON type, its validation and the domain-separated
//! token. It never generates the declaration ID or the time (the declaration
//! writer does that inside its write transaction) and never holds body text,
//! excerpts, grants, path proofs or verdicts: the binding carries digests and
//! identities only.
//!
//! v1 accepts exactly the G-01 subset of values. Anything else fails at
//! construction (`new`) or at parse time, so a stored row with another value
//! is read as unavailable rather than widened.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::canonical_json::{canonical_json_digest, canonical_json_string};
use crate::contract_string::is_contract_trimmed_non_empty;

/// Versioned identifier carried by every stored declaration.
pub const NARRATIVE_SCENE_BODY_DECLARATION_CONTRACT_ID: &str = "narrative-scene-body-declaration/1";
/// Domain-separation string hashed together with the declaration to form its
/// token. A token of another domain (the v1 Scene Scope token, a Source
/// revision token) can never equal a declaration token.
pub const NARRATIVE_SCENE_BODY_DECLARATION_TOKEN_DOMAIN: &str =
    "grimodex/narrative-scene-body-declaration-token/1";
/// Largest accepted octet length of the stored canonical JSON. The reader
/// checks it before the text is read into memory. See DR-CB1-6: about twice
/// the measured size (1171 octets) of a realistic maximal declaration (UUID
/// identifiers, RFC3339 timestamps, fixed-length digests); the field limits
/// below keep every valid declaration (1416 octets at every limit) within it.
pub const MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES: usize = 2400;
/// Largest accepted octet length of the stored token column
/// (`sha256:` plus 64 hex digits is 71 octets).
pub const MAX_NARRATIVE_SCENE_BODY_DECLARATION_TOKEN_BYTES: usize = 128;

/// Identifier-like string limit (project, Scene, incarnation, workspace).
pub const MAX_BODY_DECLARATION_ID_BYTES: usize = 64;
/// Body Source token (`v{version}@{updatedAt}`) and normalizer version limit.
pub const MAX_BODY_DECLARATION_LABEL_BYTES: usize = 64;
/// RFC3339 timestamp limit.
pub const MAX_BODY_DECLARATION_TIMESTAMP_BYTES: usize = 40;

const DIGEST_PREFIX: &str = "sha256:";
const SCENE_SOURCE_PREFIX: &str = "project:scene:";

/// The only v1 value of the story, auto, phase and POV axes.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum NarrativeBodyDeclarationIndependentV1 {
    #[serde(rename = "independent")]
    Independent,
}

/// The only v1 value of the reveal axis.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum NarrativeBodyDeclarationRevealV1 {
    #[serde(rename = "non-secret")]
    NonSecret,
}

/// What the declaration covers: the whole saved body and the title. Unplaced
/// beats and memos are never covered.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum NarrativeSceneBodyDeclarationTargetV1 {
    #[serde(rename = "body-and-title")]
    BodyAndTitle,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSceneBodyDeclarationValuesV1 {
    pub story: NarrativeBodyDeclarationIndependentV1,
    pub auto: NarrativeBodyDeclarationIndependentV1,
    pub phase: NarrativeBodyDeclarationIndependentV1,
    pub reveal: NarrativeBodyDeclarationRevealV1,
    pub pov: NarrativeBodyDeclarationIndependentV1,
}

impl NarrativeSceneBodyDeclarationValuesV1 {
    /// The G-01 subset: every axis takes its single v1 value.
    pub fn g01() -> Self {
        Self {
            story: NarrativeBodyDeclarationIndependentV1::Independent,
            auto: NarrativeBodyDeclarationIndependentV1::Independent,
            phase: NarrativeBodyDeclarationIndependentV1::Independent,
            reveal: NarrativeBodyDeclarationRevealV1::NonSecret,
            pov: NarrativeBodyDeclarationIndependentV1::Independent,
        }
    }
}

/// The body Source a declaration is bound to (digests and counts only).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSceneBodySourceV1 {
    /// `project:scene:<sceneId>`.
    pub source_identity: String,
    /// `v{version}@{updated_at}` of the Scene row.
    pub source_token: String,
    pub storage_digest: String,
    pub canonical_digest: String,
    pub normalizer_version: String,
    pub utf16_length: u64,
}

/// What a declaration is bound to. Any change of a component invalidates the
/// declaration (it is never rewritten): see "失効".
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSceneBodyDeclarationBindingV1 {
    pub project_id: String,
    pub scene_id: String,
    pub scene_incarnation_id: String,
    /// The v1 Scene Scope `source_token` at declaration time.
    pub scope_source_token: String,
    pub body_source: NarrativeSceneBodySourceV1,
    pub title_digest: String,
    pub workspace_id: String,
    pub canonical_locator_digest: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSceneBodyDeclarationV1 {
    pub contract_id: String,
    /// UUIDv4 generated by the declaration writer inside its transaction.
    pub declaration_id: String,
    /// RFC3339 time generated by the declaration writer. Recorded for display
    /// and audit only; it never orders or authorizes anything.
    pub declared_at: String,
    pub values: NarrativeSceneBodyDeclarationValuesV1,
    pub target: NarrativeSceneBodyDeclarationTargetV1,
    pub binding: NarrativeSceneBodyDeclarationBindingV1,
}

/// Why a stored declaration text could not become a declaration. Closed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NarrativeSceneBodyDeclarationParseError {
    /// Larger than [`MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES`].
    Oversized,
    /// Not JSON, not an object, or a field or value outside the v1 type.
    Malformed,
    /// `contractId` is missing or names another version.
    UnsupportedVersion,
    /// A field the v1 type does not define.
    UnknownField,
}

impl NarrativeSceneBodyDeclarationV1 {
    /// Builds a v1 declaration from fields the writer already generated.
    /// Values are always the G-01 subset and the target the whole body and
    /// title; other values cannot be constructed.
    pub fn new(
        declaration_id: impl Into<String>,
        declared_at: impl Into<String>,
        binding: NarrativeSceneBodyDeclarationBindingV1,
    ) -> anyhow::Result<Self> {
        let declaration = Self {
            contract_id: NARRATIVE_SCENE_BODY_DECLARATION_CONTRACT_ID.to_owned(),
            declaration_id: declaration_id.into(),
            declared_at: declared_at.into(),
            values: NarrativeSceneBodyDeclarationValuesV1::g01(),
            target: NarrativeSceneBodyDeclarationTargetV1::BodyAndTitle,
            binding,
        };
        declaration.validate()?;
        Ok(declaration)
    }

    /// Field-level validation. The closed enums already restrict the values
    /// and the target; this checks the strings.
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.contract_id == NARRATIVE_SCENE_BODY_DECLARATION_CONTRACT_ID,
            "unsupported scene body declaration contractId"
        );
        let id = uuid::Uuid::parse_str(&self.declaration_id)
            .map_err(|_| anyhow::anyhow!("declarationId must be a UUID"))?;
        anyhow::ensure!(
            id.get_version_num() == 4 && id.hyphenated().to_string() == self.declaration_id,
            "declarationId must be a lowercase hyphenated UUIDv4"
        );
        anyhow::ensure!(
            self.declared_at.len() <= MAX_BODY_DECLARATION_TIMESTAMP_BYTES
                && chrono::DateTime::parse_from_rfc3339(&self.declared_at).is_ok(),
            "declaredAt must be an RFC3339 timestamp"
        );
        let binding = &self.binding;
        for (value, field) in [
            (&binding.project_id, "binding.projectId"),
            (&binding.scene_id, "binding.sceneId"),
            (&binding.scene_incarnation_id, "binding.sceneIncarnationId"),
            (&binding.workspace_id, "binding.workspaceId"),
        ] {
            require_bounded(value, field, MAX_BODY_DECLARATION_ID_BYTES)?;
        }
        for (value, field) in [
            (&binding.scope_source_token, "binding.scopeSourceToken"),
            (&binding.title_digest, "binding.titleDigest"),
            (
                &binding.canonical_locator_digest,
                "binding.canonicalLocatorDigest",
            ),
            (
                &binding.body_source.storage_digest,
                "binding.bodySource.storageDigest",
            ),
            (
                &binding.body_source.canonical_digest,
                "binding.bodySource.canonicalDigest",
            ),
        ] {
            require_digest(value, field)?;
        }
        let source = &binding.body_source;
        anyhow::ensure!(
            source.source_identity == format!("{SCENE_SOURCE_PREFIX}{}", binding.scene_id),
            "binding.bodySource.sourceIdentity must name the declared Scene"
        );
        require_bounded(
            &source.source_token,
            "binding.bodySource.sourceToken",
            MAX_BODY_DECLARATION_LABEL_BYTES,
        )?;
        require_bounded(
            &source.normalizer_version,
            "binding.bodySource.normalizerVersion",
            MAX_BODY_DECLARATION_LABEL_BYTES,
        )?;
        Ok(())
    }

    /// The canonical JSON text stored in the declaration column.
    pub fn canonical_json(&self) -> anyhow::Result<String> {
        let text = canonical_json_string(&serde_json::to_value(self)?)?;
        anyhow::ensure!(
            text.len() <= MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES,
            "scene body declaration exceeds its size limit"
        );
        Ok(text)
    }

    /// The domain-separated token stored in the token column. It covers the
    /// declaration ID and time, so the same values and binding declared again
    /// (after a revoke) yield a different token.
    pub fn token(&self) -> anyhow::Result<String> {
        let value = json!({
            "domain": NARRATIVE_SCENE_BODY_DECLARATION_TOKEN_DOMAIN,
            "declaration": serde_json::to_value(self)?,
        });
        canonical_json_digest(&value).map_err(Into::into)
    }

    /// Parses stored text. The version is checked before the typed parse so a
    /// future version reads as unsupported, not malformed; an unknown field
    /// is told apart from other malformed input.
    pub fn parse_json(text: &str) -> Result<Self, NarrativeSceneBodyDeclarationParseError> {
        use NarrativeSceneBodyDeclarationParseError as Error;
        if text.len() > MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES {
            return Err(Error::Oversized);
        }
        let value: Value = serde_json::from_str(text).map_err(|_| Error::Malformed)?;
        let object = value.as_object().ok_or(Error::Malformed)?;
        match object.get("contractId").and_then(Value::as_str) {
            Some(NARRATIVE_SCENE_BODY_DECLARATION_CONTRACT_ID) => {}
            _ => return Err(Error::UnsupportedVersion),
        }
        let declaration: Self = serde_json::from_value(value).map_err(|error| {
            if error.to_string().starts_with("unknown field") {
                Error::UnknownField
            } else {
                Error::Malformed
            }
        })?;
        declaration.validate().map_err(|_| Error::Malformed)?;
        Ok(declaration)
    }
}

fn require_bounded(value: &str, field: &str, max_bytes: usize) -> anyhow::Result<()> {
    anyhow::ensure!(
        is_contract_trimmed_non_empty(value) && value.len() <= max_bytes,
        "{field} must be a trimmed non-empty string of at most {max_bytes} bytes"
    );
    Ok(())
}

fn require_digest(value: &str, field: &str) -> anyhow::Result<()> {
    let hex = value.strip_prefix(DIGEST_PREFIX).unwrap_or("");
    anyhow::ensure!(
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "{field} must be a sha256 digest"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "3f2b8f0e-5a41-4c1d-9e0a-7b6d2c4e8a11";

    fn digest(seed: char) -> String {
        format!("sha256:{}", seed.to_string().repeat(64))
    }

    fn binding() -> NarrativeSceneBodyDeclarationBindingV1 {
        NarrativeSceneBodyDeclarationBindingV1 {
            project_id: "11111111-1111-4111-8111-111111111111".into(),
            scene_id: "22222222-2222-4222-8222-222222222222".into(),
            scene_incarnation_id: "33333333-3333-4333-8333-333333333333".into(),
            scope_source_token: digest('a'),
            body_source: NarrativeSceneBodySourceV1 {
                source_identity: "project:scene:22222222-2222-4222-8222-222222222222".into(),
                source_token: "v12@2026-10-17T00:00:00.000Z".into(),
                storage_digest: digest('b'),
                canonical_digest: digest('c'),
                normalizer_version: "gdx-canonical-text/1".into(),
                utf16_length: 123_456,
            },
            title_digest: digest('d'),
            workspace_id: "44444444-4444-4444-8444-444444444444".into(),
            canonical_locator_digest: digest('e'),
        }
    }

    fn declaration() -> NarrativeSceneBodyDeclarationV1 {
        NarrativeSceneBodyDeclarationV1::new(ID, "2026-10-17T00:00:00.000Z", binding())
            .expect("valid declaration")
    }

    #[test]
    fn json_round_trips_through_the_closed_parse() {
        let declaration = declaration();
        let text = declaration.canonical_json().expect("canonical json");
        assert_eq!(
            NarrativeSceneBodyDeclarationV1::parse_json(&text),
            Ok(declaration)
        );
    }

    #[test]
    fn construction_rejects_bad_ids_times_and_digests() {
        let new =
            |id: &str, at: &str, binding| NarrativeSceneBodyDeclarationV1::new(id, at, binding);
        assert!(new("not-a-uuid", "2026-10-17T00:00:00Z", binding()).is_err());
        // UUIDv1 shape is not a v4 declaration ID.
        assert!(new(
            "3f2b8f0e-5a41-1c1d-9e0a-7b6d2c4e8a11",
            "2026-10-17T00:00:00Z",
            binding()
        )
        .is_err());
        // Upper-case is a different spelling of the same UUID; reject it so
        // one declaration has one canonical form.
        assert!(new(&ID.to_uppercase(), "2026-10-17T00:00:00Z", binding()).is_err());
        assert!(new(ID, "2026-10-17 00:00:00", binding()).is_err());
        assert!(new(ID, "yesterday", binding()).is_err());
        let mut bad = binding();
        bad.title_digest = "sha256:short".into();
        assert!(new(ID, "2026-10-17T00:00:00Z", bad).is_err());
        let mut bad = binding();
        bad.body_source.source_identity = "project:scene:other".into();
        assert!(new(ID, "2026-10-17T00:00:00Z", bad).is_err());
        let mut bad = binding();
        bad.workspace_id = " padded ".into();
        assert!(new(ID, "2026-10-17T00:00:00Z", bad).is_err());
    }

    #[test]
    fn parse_rejects_values_outside_the_v1_subset() {
        let base = serde_json::to_value(declaration()).unwrap();
        for (path, value) in [
            ("/values/story", "after-scene"),
            ("/values/auto", "conditional"),
            ("/values/phase", "phase-set"),
            ("/values/reveal", "secret"),
            ("/values/pov", "character"),
            ("/target", "body-only"),
        ] {
            let mut changed = base.clone();
            *changed.pointer_mut(path).unwrap() = json!(value);
            assert_eq!(
                NarrativeSceneBodyDeclarationV1::parse_json(&changed.to_string()),
                Err(NarrativeSceneBodyDeclarationParseError::Malformed),
                "{path}"
            );
        }
    }

    #[test]
    fn parse_tells_unknown_fields_and_versions_apart() {
        use NarrativeSceneBodyDeclarationParseError as Error;
        let base = serde_json::to_value(declaration()).unwrap();
        for pointer in ["", "/values", "/binding", "/binding/bodySource"] {
            let mut changed = base.clone();
            let target = if pointer.is_empty() {
                &mut changed
            } else {
                changed.pointer_mut(pointer).unwrap()
            };
            target
                .as_object_mut()
                .unwrap()
                .insert("excerpt".into(), json!("本文"));
            assert_eq!(
                NarrativeSceneBodyDeclarationV1::parse_json(&changed.to_string()),
                Err(Error::UnknownField),
                "unknown field at '{pointer}'"
            );
        }
        let mut future = base.clone();
        future["contractId"] = json!("narrative-scene-body-declaration/2");
        assert_eq!(
            NarrativeSceneBodyDeclarationV1::parse_json(&future.to_string()),
            Err(Error::UnsupportedVersion)
        );
        let mut versionless = base;
        versionless.as_object_mut().unwrap().remove("contractId");
        assert_eq!(
            NarrativeSceneBodyDeclarationV1::parse_json(&versionless.to_string()),
            Err(Error::UnsupportedVersion)
        );
        for text in ["", "[]", "\"x\"", "{", "null"] {
            let result = NarrativeSceneBodyDeclarationV1::parse_json(text);
            assert!(
                matches!(
                    result,
                    Err(Error::Malformed) | Err(Error::UnsupportedVersion)
                ),
                "{text}: {result:?}"
            );
        }
    }

    #[test]
    fn token_is_domain_separated_and_covers_the_declaration_id() {
        let first = declaration();
        let token = first.token().expect("token");
        assert!(token.starts_with("sha256:") && token.len() == 71);
        assert_eq!(token, first.token().unwrap());
        // Same values and binding, new declaration ID (revoke then declare
        // again): a different token, so a stale token cannot come back.
        let again = NarrativeSceneBodyDeclarationV1::new(
            "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
            "2026-10-17T00:00:00.000Z",
            binding(),
        )
        .unwrap();
        assert_ne!(token, again.token().unwrap());
        // The time is also covered.
        let later = NarrativeSceneBodyDeclarationV1::new(ID, "2026-10-17T00:00:01.000Z", binding())
            .unwrap();
        assert_ne!(token, later.token().unwrap());
        // The domain string is part of the hashed value.
        let undomained = canonical_json_digest(&serde_json::to_value(&first).unwrap()).unwrap();
        assert_ne!(token, undomained);
    }

    #[test]
    fn token_covers_every_binding_component() {
        let base = declaration().token().unwrap();
        let mut variants = Vec::new();
        let mut push = |mutate: &dyn Fn(&mut NarrativeSceneBodyDeclarationBindingV1)| {
            let mut changed = binding();
            mutate(&mut changed);
            variants.push(changed);
        };
        push(&|b| b.scene_incarnation_id = "other-incarnation".into());
        push(&|b| b.scope_source_token = digest('0'));
        push(&|b| b.body_source.source_token = "v13@2026-10-17T00:00:00.000Z".into());
        push(&|b| b.body_source.storage_digest = digest('0'));
        push(&|b| b.body_source.canonical_digest = digest('0'));
        push(&|b| b.body_source.utf16_length += 1);
        push(&|b| b.title_digest = digest('0'));
        push(&|b| b.workspace_id = "other-workspace".into());
        push(&|b| b.canonical_locator_digest = digest('0'));
        for changed in variants {
            let other =
                NarrativeSceneBodyDeclarationV1::new(ID, "2026-10-17T00:00:00.000Z", changed)
                    .unwrap();
            assert_ne!(base, other.token().unwrap());
        }
    }

    #[test]
    fn oversized_text_is_rejected_before_parsing() {
        let text = format!(
            "{{\"contractId\":\"{}\",\"pad\":\"{}\"}}",
            NARRATIVE_SCENE_BODY_DECLARATION_CONTRACT_ID,
            "x".repeat(MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES)
        );
        assert_eq!(
            NarrativeSceneBodyDeclarationV1::parse_json(&text),
            Err(NarrativeSceneBodyDeclarationParseError::Oversized)
        );
    }

    /// DR-CB1-6: the measured sizes behind
    /// [`MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES`].
    #[test]
    fn size_limit_is_twice_the_realistic_maximum_and_covers_the_field_limits() {
        let realistic = declaration().canonical_json().unwrap().len();
        // Every string field at its limit: still within the stored limit, so
        // every declaration the type accepts can be stored and read back.
        let long = |max: usize| "a".repeat(max);
        let scene_id = long(MAX_BODY_DECLARATION_ID_BYTES);
        let mut maximal = binding();
        maximal.project_id = long(MAX_BODY_DECLARATION_ID_BYTES);
        maximal.scene_incarnation_id = long(MAX_BODY_DECLARATION_ID_BYTES);
        maximal.workspace_id = long(MAX_BODY_DECLARATION_ID_BYTES);
        maximal.body_source.source_identity = format!("project:scene:{scene_id}");
        maximal.scene_id = scene_id;
        maximal.body_source.source_token = long(MAX_BODY_DECLARATION_LABEL_BYTES);
        maximal.body_source.normalizer_version = long(MAX_BODY_DECLARATION_LABEL_BYTES);
        maximal.body_source.utf16_length = u64::MAX;
        let maximal = NarrativeSceneBodyDeclarationV1::new(
            ID,
            "2026-10-17T00:00:00.123456789+09:00",
            maximal,
        )
        .unwrap()
        .canonical_json()
        .expect("a declaration at every field limit fits the stored limit");
        assert!(
            realistic * 2 <= MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES,
            "limit is at least twice the realistic size {realistic}"
        );
        assert!(
            MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES < realistic * 3,
            "limit stays near twice the realistic size {realistic}"
        );
        assert!(maximal.len() <= MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES);
    }
}
