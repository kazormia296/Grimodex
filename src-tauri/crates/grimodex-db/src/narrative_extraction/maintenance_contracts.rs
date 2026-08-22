//! Rust-owned maintenance contract coordinates.
//!
//! These coordinates are compiled from the executable graph/finding
//! contracts and the bundled producer-generation registry.  They are not
//! workspace data and are never accepted from an Electron wake request.

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::consumer_identity::{PROPOSAL_REVISION_CONSUMER_KIND, RUN_CONSUMER_KIND};
use super::dependency_edges::SOURCE_IDENTITY_PREFIXES;
use super::finding_identity::bundled_finding_rule_registry;
use super::repository::PROPOSAL_REVISION_DEPENDENCY_GENERATION;

const BUNDLED_PRODUCER_REGISTRY: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../policies/narrative/narrative-dependency-producer-registry.json"
));

const GRAPH_CONTRACT_DOMAIN: &str = "grimodex:narrative:graph-contract:v1";
const FINDING_RULE_DOMAIN: &str = "grimodex:narrative:finding-rule-registry:v1";
const PRODUCER_GENERATION_DOMAIN: &str = "grimodex:narrative:producer-generation-set:v1";

const EXPECTED_PRODUCER_WRITERS: &[(&str, &str, &str, &str, &str)] = &[
    (
        "proposal-revision-source-basis",
        "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
        "record_revision_dependency_edges_in_tx",
        PROPOSAL_REVISION_DEPENDENCY_GENERATION,
        PROPOSAL_REVISION_CONSUMER_KIND,
    ),
    (
        "legacy-application-projection-dependency",
        "src-tauri/crates/grimodex-db/src/narrative_extraction/legacy_backfill.rs",
        "record_legacy_dependency_edges_in_tx",
        "legacy-dependency-backfill:v2",
        RUN_CONSUMER_KIND,
    ),
];

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceContractCoordinates {
    pub graph_contract_digest: String,
    pub rule_registry_digest: String,
    pub producer_generation_set_digest: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct DependencyProducerWriter {
    pub module: String,
    pub symbol: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyProducerEntry {
    pub id: String,
    pub writer: DependencyProducerWriter,
    pub generation: String,
    pub consumer_kind: String,
    pub declaration: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DependencyProducerRegistryDocument {
    schema_version: u32,
    contract: String,
    registry_version: String,
    entries: Vec<DependencyProducerEntry>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct DependencyProducerRegistry {
    schema_version: u32,
    registry_version: String,
    entries: Vec<DependencyProducerEntry>,
}

impl DependencyProducerRegistry {
    pub fn schema_version(&self) -> u32 {
        self.schema_version
    }

    pub fn registry_version(&self) -> &str {
        &self.registry_version
    }

    pub fn entries(&self) -> &[DependencyProducerEntry] {
        &self.entries
    }
}

/// Parse and validate the bundled V1 registry. Every entry is tied to a
/// concrete writer symbol and a generation owned by the corresponding Rust
/// writer path; malformed or incomplete registry data fails closed.
pub fn bundled_dependency_producer_registry() -> Result<DependencyProducerRegistry> {
    let document: DependencyProducerRegistryDocument =
        serde_json::from_str(BUNDLED_PRODUCER_REGISTRY)
            .context("NEX_PRODUCER_REGISTRY_INVALID: bundled registry JSON")?;
    ensure!(
        document.schema_version == 1,
        "NEX_PRODUCER_REGISTRY_INVALID: unsupported schemaVersion {}",
        document.schema_version
    );
    ensure!(
        document.contract == "narrative-dependency-producer-generation-registry",
        "NEX_PRODUCER_REGISTRY_INVALID: unexpected contract"
    );
    ensure!(
        document.registry_version == "narrative-producer-generation/v1",
        "NEX_PRODUCER_REGISTRY_INVALID: unexpected registryVersion"
    );
    ensure!(
        !document.entries.is_empty(),
        "NEX_PRODUCER_REGISTRY_INVALID: no producer entries"
    );
    ensure!(
        document.entries.len() == EXPECTED_PRODUCER_WRITERS.len(),
        "NEX_PRODUCER_REGISTRY_INVALID: registry entry count does not match implemented writer set"
    );

    for (index, entry) in document.entries.iter().enumerate() {
        ensure!(
            !entry.id.trim().is_empty()
                && !entry.generation.trim().is_empty()
                && !entry.consumer_kind.trim().is_empty()
                && !entry.declaration.trim().is_empty(),
            "NEX_PRODUCER_REGISTRY_INVALID: entry {index} has an empty identity"
        );
        ensure!(
            !entry.writer.module.trim().is_empty() && !entry.writer.symbol.trim().is_empty(),
            "NEX_PRODUCER_REGISTRY_INVALID: entry {index} has no writer symbol"
        );
        ensure!(
            document.entries[..index]
                .iter()
                .all(|previous| previous.id != entry.id),
            "NEX_PRODUCER_REGISTRY_INVALID: duplicate producer id '{}'",
            entry.id
        );
    }
    for (id, module, symbol, generation, consumer_kind) in EXPECTED_PRODUCER_WRITERS {
        let entry = document
            .entries
            .iter()
            .find(|entry| entry.id == *id)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_PRODUCER_REGISTRY_INVALID: implemented writer '{id}' is missing"
                )
            })?;
        ensure!(
            entry.writer.module == *module
                && entry.writer.symbol == *symbol
                && entry.generation == *generation
                && entry.consumer_kind == *consumer_kind,
            "NEX_PRODUCER_REGISTRY_INVALID: writer '{id}' does not match its Rust source contract"
        );
    }

    let mut entries = document.entries;
    entries.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(DependencyProducerRegistry {
        schema_version: document.schema_version,
        registry_version: document.registry_version,
        entries,
    })
}

/// Compute all current coordinates in one call so a caller cannot mix values
/// from different bundled contract versions.
pub fn current_maintenance_coordinates() -> Result<MaintenanceContractCoordinates> {
    let graph_contract = json!({
        "contractVersion": "narrative-dependency-graph/v1",
        "sourceIdentityPrefixes": SOURCE_IDENTITY_PREFIXES,
        "consumerKinds": [RUN_CONSUMER_KIND, PROPOSAL_REVISION_CONSUMER_KIND],
        "edgeColumns": [
            "projectId", "consumerKind", "consumerKey", "sourceObjectIdentity",
            "readSetJson", "generatedByTransactionId", "owningRunId"
        ],
        "readSetShape": "json-array-of-revision-tokens",
        "declarationWriteAuthority": "producer-transaction"
    });
    let graph_contract_digest = domain_digest(GRAPH_CONTRACT_DOMAIN, &graph_contract)?;

    let finding_registry = bundled_finding_rule_registry()?;
    let rule_registry_digest = domain_digest(
        FINDING_RULE_DOMAIN,
        &finding_registry.canonical_value()?,
    )?;

    let producer_registry = bundled_dependency_producer_registry()?;
    let producer_generation_set_digest = producer_generation_set_digest(&producer_registry)?;

    Ok(MaintenanceContractCoordinates {
        graph_contract_digest,
        rule_registry_digest,
        producer_generation_set_digest,
    })
}

fn producer_generation_set_digest(registry: &DependencyProducerRegistry) -> Result<String> {
    domain_digest(
        PRODUCER_GENERATION_DOMAIN,
        &serde_json::to_value(registry.entries())?,
    )
}

fn domain_digest(domain: &str, value: &serde_json::Value) -> Result<String> {
    let canonical = serde_json::to_vec(&(domain, value))?;
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(canonical))
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_digest_changes_when_a_writer_generation_changes() {
        let registry = bundled_dependency_producer_registry().expect("registry");
        let mut entries = registry.entries().to_vec();
        entries[0].generation.push_str("-changed");
        let first = producer_generation_set_digest(&registry).expect("first digest");
        let changed = DependencyProducerRegistry {
            schema_version: registry.schema_version,
            registry_version: registry.registry_version.clone(),
            entries,
        };
        let second = producer_generation_set_digest(&changed).expect("second digest");
        assert_ne!(first, second);
    }

    #[test]
    fn producer_registry_digest_is_independent_of_input_order() {
        let registry = bundled_dependency_producer_registry().expect("registry");
        let mut reversed = registry.entries().to_vec();
        reversed.reverse();
        reversed.sort_by(|left, right| left.id.cmp(&right.id));
        let reordered = DependencyProducerRegistry {
            schema_version: registry.schema_version,
            registry_version: registry.registry_version.clone(),
            entries: reversed,
        };
        assert_eq!(
            producer_generation_set_digest(&registry).expect("first digest"),
            producer_generation_set_digest(&reordered).expect("reordered digest")
        );
    }
}
