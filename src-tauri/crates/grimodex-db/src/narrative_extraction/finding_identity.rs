//! Versioned, bundled Finding Rule Registry and stable Finding identity.
//!
//! This module deliberately keeps the rule contract in the repository rather
//! than in workspace data.  A workspace may contain derived observations, but
//! it must not be able to replace the executable meaning of a Finding rule.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const BUNDLED_FINDING_RULE_ID: &str = "narrative.consumer-freshness";
pub const BUNDLED_FINDING_RULE_VERSION: u32 = 1;
pub const MAINTENANCE_FAILURE_FINDING_RULE_ID: &str = "narrative.maintenance-contract-failure";
pub const MAINTENANCE_FAILURE_FINDING_RULE_VERSION: u32 = 1;

const EDGE_IDENTITY_SCOPE: &str = "edge";
const MAINTENANCE_WORK_IDENTITY_SCOPE: &str = "maintenance-work";
const DURABLE_DERIVED_HISTORY_STORAGE_CLASS: &str = "durable-derived-history";
const MAINTENANCE_RUN_FINALIZATION_AUTHORITY: &str = "maintenance-run-finalization-transaction";
const EDGE_REQUIRED_FIELDS: &[&str] =
    &["stableSubject", "edgeId", "reasonCode", "evidenceFreshness"];
const MAINTENANCE_WORK_REQUIRED_FIELDS: &[&str] = &[
    "stableSubject",
    "failureCode",
    "reasonCode",
    "evidenceFreshness",
];
const EDGE_REQUIRED_MATERIAL_BASIS_FIELDS: &[&str] =
    &["stableSubject", "edgeId", "reasonCode", "evidenceFreshness"];
const MAINTENANCE_WORK_REQUIRED_MATERIAL_BASIS_FIELDS: &[&str] = &[
    "stableSubject",
    "failureCode",
    "reasonCode",
    "evidenceFreshness",
];

const BUNDLED_FINDING_CONTRACT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../policies/narrative/narrative-finding-contract.json"
));

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct FindingRule {
    #[serde(rename = "ruleId")]
    pub rule_id: String,
    pub version: u32,
    #[serde(rename = "identityScope")]
    pub identity_scope: String,
    #[serde(rename = "observationFields")]
    pub observation_fields: Vec<String>,
    #[serde(rename = "materialBasisFields")]
    pub material_basis_fields: Vec<String>,
    /// Only the terminal maintenance rule may override the contract-wide
    /// rebuildable observation default.  Keep this parsed at runtime so a
    /// malformed bundled policy cannot silently fall back to an unsafe
    /// default when the JSON schema is bypassed.
    #[serde(rename = "observationStorageClass")]
    pub observation_storage_class: Option<String>,
    /// The terminal rule is written by the maintenance Run finalization
    /// transaction, not by the evaluator publish authority used by edge
    /// observations.
    #[serde(rename = "writerAuthority")]
    pub writer_authority: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct FindingContractDocument {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    contract: String,
    rules: Vec<FindingRule>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FindingRuleRegistry {
    rules: Vec<FindingRule>,
}

impl FindingRuleRegistry {
    pub fn resolve(&self, rule_id: &str, version: u32) -> anyhow::Result<&FindingRule> {
        self.rules
            .iter()
            .find(|rule| rule.rule_id == rule_id && rule.version == version)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_FINDING_RULE_UNKNOWN: no bundled Finding rule '{rule_id}' version {version}"
                )
            })
    }
}

fn validate_declared_fields(
    rule: &FindingRule,
    fields: &[String],
    required: &[&str],
    field_kind: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !fields.is_empty(),
        "NEX_FINDING_RULE_REGISTRY_INVALID: rule '{}@{}' has no {field_kind}",
        rule.rule_id,
        rule.version
    );
    anyhow::ensure!(
        fields
            .iter()
            .all(|field| required.contains(&field.as_str())),
        "NEX_FINDING_RULE_REGISTRY_INVALID: rule '{}@{}' has an unsupported {field_kind} field",
        rule.rule_id,
        rule.version
    );
    anyhow::ensure!(
        fields
            .iter()
            .all(|field| { fields.iter().filter(|other| *other == field).count() == 1 }),
        "NEX_FINDING_RULE_REGISTRY_INVALID: rule '{}@{}' has duplicate {field_kind} fields",
        rule.rule_id,
        rule.version
    );
    for field in required {
        anyhow::ensure!(
            fields.iter().any(|declared| declared == field),
            "NEX_FINDING_RULE_REGISTRY_INVALID: rule '{}@{}' is missing {field_kind} field '{field}'",
            rule.rule_id,
            rule.version
        );
    }
    Ok(())
}

fn validate_finding_rule(rule: &FindingRule, index: usize) -> anyhow::Result<()> {
    anyhow::ensure!(
        !rule.rule_id.trim().is_empty()
            && rule.rule_id.chars().all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || matches!(character, '.' | '-' | '_')
            }),
        "NEX_FINDING_RULE_REGISTRY_INVALID: rule {index} has an invalid ruleId"
    );
    anyhow::ensure!(
        rule.version > 0,
        "NEX_FINDING_RULE_REGISTRY_INVALID: rule {index} has an invalid version"
    );
    anyhow::ensure!(
        matches!(
            rule.identity_scope.as_str(),
            EDGE_IDENTITY_SCOPE | MAINTENANCE_WORK_IDENTITY_SCOPE
        ),
        "NEX_FINDING_RULE_REGISTRY_INVALID: rule '{}@{}' has unsupported identityScope '{}'",
        rule.rule_id,
        rule.version,
        rule.identity_scope
    );
    let (required_observation_fields, required_material_basis_fields) = match rule
        .identity_scope
        .as_str()
    {
        EDGE_IDENTITY_SCOPE => (EDGE_REQUIRED_FIELDS, EDGE_REQUIRED_MATERIAL_BASIS_FIELDS),
        MAINTENANCE_WORK_IDENTITY_SCOPE => (
            MAINTENANCE_WORK_REQUIRED_FIELDS,
            MAINTENANCE_WORK_REQUIRED_MATERIAL_BASIS_FIELDS,
        ),
        _ => anyhow::bail!(
            "NEX_FINDING_RULE_REGISTRY_INVALID: unsupported identityScope '{}', rule validation did not accept it",
            rule.identity_scope
        ),
    };
    validate_declared_fields(
        rule,
        &rule.observation_fields,
        required_observation_fields,
        "observationFields",
    )?;
    validate_declared_fields(
        rule,
        &rule.material_basis_fields,
        required_material_basis_fields,
        "materialBasisFields",
    )?;
    match rule.identity_scope.as_str() {
        EDGE_IDENTITY_SCOPE => {
            anyhow::ensure!(
                rule.observation_storage_class.is_none(),
                "NEX_FINDING_RULE_REGISTRY_INVALID: edge rule '{}@{}' must not override observationStorageClass",
                rule.rule_id,
                rule.version
            );
            anyhow::ensure!(
                rule.writer_authority.is_none(),
                "NEX_FINDING_RULE_REGISTRY_INVALID: edge rule '{}@{}' must not override writerAuthority",
                rule.rule_id,
                rule.version
            );
        }
        MAINTENANCE_WORK_IDENTITY_SCOPE => {
            anyhow::ensure!(
                rule.observation_storage_class.as_deref()
                    == Some(DURABLE_DERIVED_HISTORY_STORAGE_CLASS),
                "NEX_FINDING_RULE_REGISTRY_INVALID: maintenance-work rule '{}@{}' must declare observationStorageClass '{}'",
                rule.rule_id,
                rule.version,
                DURABLE_DERIVED_HISTORY_STORAGE_CLASS
            );
            anyhow::ensure!(
                rule.writer_authority.as_deref() == Some(MAINTENANCE_RUN_FINALIZATION_AUTHORITY),
                "NEX_FINDING_RULE_REGISTRY_INVALID: maintenance-work rule '{}@{}' must declare writerAuthority '{}'",
                rule.rule_id,
                rule.version,
                MAINTENANCE_RUN_FINALIZATION_AUTHORITY
            );
        }
        _ => unreachable!("identity scope validated above"),
    }
    Ok(())
}

/// Parse the executable registry from the bundled policy on every call. The
/// policy is compiled into the binary, so a workspace cannot replace it; a
/// malformed or incomplete bundle is an explicit fail-closed error.
pub fn bundled_finding_rule_registry() -> anyhow::Result<FindingRuleRegistry> {
    let document: FindingContractDocument = serde_json::from_str(BUNDLED_FINDING_CONTRACT)
        .map_err(|error| anyhow::anyhow!("NEX_FINDING_RULE_REGISTRY_INVALID: {error}"))?;
    anyhow::ensure!(
        document.schema_version == 1,
        "NEX_FINDING_RULE_REGISTRY_INVALID: unsupported schemaVersion {}",
        document.schema_version
    );
    anyhow::ensure!(
        document.contract == "narrative-finding-contract",
        "NEX_FINDING_RULE_REGISTRY_INVALID: unexpected contract"
    );
    anyhow::ensure!(
        !document.rules.is_empty(),
        "NEX_FINDING_RULE_REGISTRY_INVALID: no rules are bundled"
    );

    for (index, rule) in document.rules.iter().enumerate() {
        validate_finding_rule(rule, index)?;
        anyhow::ensure!(
            !rule.identity_scope.trim().is_empty(),
            "NEX_FINDING_RULE_REGISTRY_INVALID: rule {index} has no identityScope"
        );
        anyhow::ensure!(
            !document.rules[..index].iter().any(|previous| {
                previous.rule_id == rule.rule_id && previous.version == rule.version
            }),
            "NEX_FINDING_RULE_REGISTRY_INVALID: duplicate rule '{}@{}'",
            rule.rule_id,
            rule.version
        );
    }
    Ok(FindingRuleRegistry {
        rules: document.rules,
    })
}

#[derive(Clone, Debug, Serialize)]
pub struct ObservationDigestInput<'a> {
    pub stable_subject: &'a str,
    pub edge_id: Option<&'a str>,
    pub failure_code: Option<&'a str>,
    pub reason_code: &'a str,
    pub evidence_freshness: &'a str,
}

/// The durable result fields that make an Attention disposition stale. Run
/// id, Semantic Epoch, and wall-clock time are intentionally absent: those
/// identify an evaluation, not the material basis of the Finding.
#[derive(Clone, Debug, Serialize)]
pub struct MaterialBasisInput<'a> {
    pub stable_subject: &'a str,
    pub edge_id: Option<&'a str>,
    pub failure_code: Option<&'a str>,
    pub reason_code: &'a str,
    pub evidence_freshness: &'a str,
}

fn resolve_bundled_rule(rule_id: &str, version: u32) -> anyhow::Result<FindingRule> {
    let registry = bundled_finding_rule_registry()?;
    Ok(registry.resolve(rule_id, version)?.clone())
}

fn declared_field_values(
    fields: &[String],
    mut value_for: impl FnMut(&str) -> Option<serde_json::Value>,
) -> anyhow::Result<Vec<serde_json::Value>> {
    fields
        .iter()
        .map(|field| {
            value_for(field).ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_FINDING_RULE_REGISTRY_INVALID: unsupported declared digest field '{field}'"
                )
            })
        })
        .collect()
}

pub fn stable_finding_identity(
    rule_id: &str,
    version: u32,
    stable_subject: &str,
) -> anyhow::Result<String> {
    let rule = resolve_bundled_rule(rule_id, version)?;
    anyhow::ensure!(
        !stable_subject.trim().is_empty(),
        "NEX_FINDING_IDENTITY_INVALID: stable subject is required"
    );
    let canonical = format!(
        "{}|{}|{}|{}",
        rule.rule_id, rule.version, rule.identity_scope, stable_subject
    );
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(canonical.as_bytes()))
    ))
}

pub fn observation_digest(
    rule_id: &str,
    version: u32,
    input: &ObservationDigestInput<'_>,
) -> anyhow::Result<String> {
    let rule = resolve_bundled_rule(rule_id, version)?;
    anyhow::ensure!(
        !input.stable_subject.trim().is_empty(),
        "NEX_FINDING_DIGEST_INVALID: stable subject is required"
    );
    let declared_values = declared_field_values(&rule.observation_fields, |field| match field {
        "stableSubject" => Some(serde_json::json!(input.stable_subject)),
        "edgeId" => Some(serde_json::json!(input.edge_id)),
        "failureCode" => Some(serde_json::json!(input.failure_code)),
        "reasonCode" => Some(serde_json::json!(input.reason_code)),
        "evidenceFreshness" => Some(serde_json::json!(input.evidence_freshness)),
        _ => None,
    })?;
    let canonical = serde_json::to_vec(&(
        "narrative-finding-observation",
        rule.rule_id,
        rule.version,
        rule.observation_fields,
        declared_values,
    ))?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(canonical))))
}

pub fn material_basis_digest(
    rule_id: &str,
    version: u32,
    input: &MaterialBasisInput<'_>,
) -> anyhow::Result<String> {
    let rule = resolve_bundled_rule(rule_id, version)?;
    anyhow::ensure!(
        !input.stable_subject.trim().is_empty(),
        "NEX_FINDING_DIGEST_INVALID: stable subject is required"
    );
    let declared_values =
        declared_field_values(&rule.material_basis_fields, |field| match field {
            "stableSubject" => Some(serde_json::json!(input.stable_subject)),
            "edgeId" => Some(serde_json::json!(input.edge_id)),
            "failureCode" => Some(serde_json::json!(input.failure_code)),
            "reasonCode" => Some(serde_json::json!(input.reason_code)),
            "evidenceFreshness" => Some(serde_json::json!(input.evidence_freshness)),
            _ => None,
        })?;
    let canonical = serde_json::to_vec(&(
        "narrative-finding-material-basis",
        rule.rule_id,
        rule.version,
        rule.identity_scope,
        rule.material_basis_fields,
        declared_values,
    ))?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(canonical))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_registry_has_a_versioned_rule_and_rejects_unknown_versions() {
        let registry = bundled_finding_rule_registry().expect("bundled registry");
        let rule = registry
            .resolve(BUNDLED_FINDING_RULE_ID, BUNDLED_FINDING_RULE_VERSION)
            .expect("bundled rule");
        assert_eq!(rule.rule_id, BUNDLED_FINDING_RULE_ID);
        assert_eq!(rule.version, BUNDLED_FINDING_RULE_VERSION);
        assert!(registry
            .resolve("narrative.unknown", BUNDLED_FINDING_RULE_VERSION)
            .is_err());
        assert!(registry
            .resolve(BUNDLED_FINDING_RULE_ID, BUNDLED_FINDING_RULE_VERSION + 1)
            .is_err());
    }

    #[test]
    fn bundled_rule_registry_rejects_unsupported_missing_and_duplicate_contract_fields() {
        let registry = bundled_finding_rule_registry().expect("bundled registry");
        let bundled = registry
            .resolve(BUNDLED_FINDING_RULE_ID, BUNDLED_FINDING_RULE_VERSION)
            .expect("bundled rule")
            .clone();

        let mut unsupported_scope = bundled.clone();
        unsupported_scope.identity_scope = "project".to_string();
        assert!(validate_finding_rule(&unsupported_scope, 0).is_err());

        let mut missing_observation = bundled.clone();
        missing_observation.observation_fields.pop();
        assert!(validate_finding_rule(&missing_observation, 0).is_err());

        let mut duplicate_observation = bundled.clone();
        duplicate_observation.observation_fields[1] = "stableSubject".to_string();
        assert!(validate_finding_rule(&duplicate_observation, 0).is_err());

        let mut unsupported_material = bundled.clone();
        unsupported_material.material_basis_fields[0] = "runId".to_string();
        assert!(validate_finding_rule(&unsupported_material, 0).is_err());

        let mut missing_material = bundled.clone();
        missing_material.material_basis_fields.pop();
        assert!(validate_finding_rule(&missing_material, 0).is_err());

        let mut duplicate_material = bundled;
        duplicate_material.material_basis_fields[1] = "stableSubject".to_string();
        assert!(validate_finding_rule(&duplicate_material, 0).is_err());
    }

    #[test]
    fn bundled_rule_registry_requires_terminal_storage_and_writer_authority_overrides() {
        let registry = bundled_finding_rule_registry().expect("bundled registry");
        let maintenance = registry
            .resolve(
                MAINTENANCE_FAILURE_FINDING_RULE_ID,
                MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
            )
            .expect("maintenance rule")
            .clone();

        let mut missing_storage_class = maintenance.clone();
        missing_storage_class.observation_storage_class = None;
        assert!(validate_finding_rule(&missing_storage_class, 0).is_err());

        let mut wrong_storage_class = maintenance.clone();
        wrong_storage_class.observation_storage_class =
            Some("rebuildable-derived-state".to_string());
        assert!(validate_finding_rule(&wrong_storage_class, 0).is_err());

        let mut missing_writer_authority = maintenance.clone();
        missing_writer_authority.writer_authority = None;
        assert!(validate_finding_rule(&missing_writer_authority, 0).is_err());

        let mut edge = registry
            .resolve(BUNDLED_FINDING_RULE_ID, BUNDLED_FINDING_RULE_VERSION)
            .expect("edge rule")
            .clone();
        edge.observation_storage_class = Some(DURABLE_DERIVED_HISTORY_STORAGE_CLASS.to_string());
        assert!(validate_finding_rule(&edge, 0).is_err());
    }

    #[test]
    fn stable_identity_is_independent_of_run_and_epoch() {
        let first = stable_finding_identity(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            "edge:edge-1",
        )
        .expect("identity");
        let second = stable_finding_identity(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            "edge:edge-1",
        )
        .expect("identity");
        assert_eq!(first, second);
        assert_ne!(
            first,
            stable_finding_identity(
                BUNDLED_FINDING_RULE_ID,
                BUNDLED_FINDING_RULE_VERSION,
                "edge:edge-2",
            )
            .expect("identity")
        );
    }

    #[test]
    fn observation_digest_excludes_run_epoch_and_wall_clock() {
        let input = ObservationDigestInput {
            stable_subject: "edge:edge-1",
            edge_id: Some("edge-1"),
            failure_code: None,
            reason_code: "source-missing",
            evidence_freshness: "source-missing",
        };
        let first = observation_digest(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            &input,
        )
        .expect("digest");
        let second = observation_digest(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            &input,
        )
        .expect("digest");
        assert_eq!(first, second);
        assert!(!first.contains("run-"));
        assert!(!first.contains("epoch-"));
        assert!(!first.contains("2026-"));
    }

    #[test]
    fn material_basis_digest_tracks_material_inputs_but_not_run_context() {
        let stable_subject = "edge:edge-1";
        let first_input = MaterialBasisInput {
            stable_subject,
            edge_id: Some("edge-1"),
            failure_code: None,
            reason_code: "source-missing",
            evidence_freshness: "source-missing",
        };
        // Run id, Semantic Epoch, and wall-clock time are deliberately not
        // arguments to this digest. Two evaluations with only that context
        // changed therefore have the same material basis.
        let first = material_basis_digest(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            &first_input,
        )
        .expect("material basis");
        let harmless_rerun = material_basis_digest(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            &first_input,
        )
        .expect("material basis");
        assert_eq!(first, harmless_rerun);

        let reason_changed = material_basis_digest(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            &MaterialBasisInput {
                reason_code: "source-revision-changed",
                ..first_input.clone()
            },
        )
        .expect("material basis");
        assert_ne!(first, reason_changed);

        let freshness_changed = material_basis_digest(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            &MaterialBasisInput {
                evidence_freshness: "stale",
                ..first_input.clone()
            },
        )
        .expect("material basis");
        assert_ne!(first, freshness_changed);

        let observation = observation_digest(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            &ObservationDigestInput {
                stable_subject,
                edge_id: Some("edge-1"),
                failure_code: None,
                reason_code: "source-missing",
                evidence_freshness: "source-missing",
            },
        )
        .expect("observation digest");
        // The two digests are domain-separated and cannot be accidentally
        // substituted when an observation changes.
        assert_ne!(first, observation);
    }
}
