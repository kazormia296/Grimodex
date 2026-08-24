//! Rust-owned maintenance contract coordinates.
//!
//! These coordinates are compiled from the executable graph/finding
//! contracts and the bundled producer-generation registry.  They are not
//! workspace data and are never accepted from an Electron wake request.

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::consumer_identity::{
    APPLICATION_CONSUMER_KIND, PROPOSAL_REVISION_CONSUMER_KIND, RUN_CONSUMER_KIND,
};
use super::dependency_edges::SOURCE_IDENTITY_PREFIXES;
use super::finding_identity::bundled_finding_rule_registry;
use super::legacy_backfill::LEGACY_DEPENDENCY_PRODUCER_GENERATION;
use super::repository::{
    PROPOSAL_REVISION_D1_PRODUCER_GENERATION, PROPOSAL_REVISION_DEPENDENCY_GENERATION,
};

const BUNDLED_PRODUCER_REGISTRY: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../policies/narrative/narrative-dependency-producer-registry.json"
));

const GRAPH_CONTRACT_DOMAIN: &str = "grimodex:narrative:graph-contract:v1";
const FINDING_RULE_DOMAIN: &str = "grimodex:narrative:finding-rule-registry:v1";
const PRODUCER_GENERATION_DOMAIN: &str = "grimodex:narrative:producer-generation-set:v1";
const CI_COORDINATE_MISMATCH_DOMAIN: &str = "grimodex:narrative:ci-coordinate-mismatch:v1";

#[allow(clippy::type_complexity)]
const EXPECTED_PRODUCER_WRITERS: &[(&str, &str, &str, &str, &str, Option<i64>)] = &[
    (
        "proposal-revision-source-basis",
        "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
        "record_revision_dependency_edges_in_tx",
        PROPOSAL_REVISION_DEPENDENCY_GENERATION,
        PROPOSAL_REVISION_CONSUMER_KIND,
        Some(PROPOSAL_REVISION_D1_PRODUCER_GENERATION),
    ),
    (
        "legacy-application-projection-dependency",
        "src-tauri/crates/grimodex-db/src/narrative_extraction/legacy_backfill.rs",
        "record_legacy_dependency_edges_in_tx",
        LEGACY_DEPENDENCY_PRODUCER_GENERATION,
        APPLICATION_CONSUMER_KIND,
        None,
    ),
];

const REPOSITORY_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/narrative_extraction/repository.rs"
));
const LEGACY_BACKFILL_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/narrative_extraction/legacy_backfill.rs"
));

const PRODUCER_MARKER_PREFIX: &str = "// NARRATIVE_DEPENDENCY_PRODUCER: ";

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
    #[serde(default)]
    pub declaration_set_generation: Option<i64>,
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
/// writer path. The applicable D1 declaration-set generation is separately
/// numeric and writer-owned; malformed or incomplete registry data fails
/// closed.
pub fn bundled_dependency_producer_registry() -> Result<DependencyProducerRegistry> {
    parse_dependency_producer_registry(BUNDLED_PRODUCER_REGISTRY)
}

fn parse_dependency_producer_registry(registry_json: &str) -> Result<DependencyProducerRegistry> {
    let document: DependencyProducerRegistryDocument = serde_json::from_str(registry_json)
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
    for (id, module, symbol, generation, consumer_kind, declaration_set_generation) in
        EXPECTED_PRODUCER_WRITERS
    {
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
        ensure!(
            entry.declaration_set_generation == *declaration_set_generation,
            "NEX_PRODUCER_REGISTRY_INVALID: writer '{id}' declarationSetGeneration does not match its Rust source contract"
        );
        let source = match *module {
            "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs" => {
                REPOSITORY_SOURCE
            }
            "src-tauri/crates/grimodex-db/src/narrative_extraction/legacy_backfill.rs" => {
                LEGACY_BACKFILL_SOURCE
            }
            _ => "",
        };
        ensure!(
            source.contains(&format!("fn {symbol}(")),
            "NEX_PRODUCER_REGISTRY_INVALID: writer '{id}' symbol is not present at '{}'",
            module
        );
    }
    validate_dependency_producer_traceability(&document.entries)?;

    let mut entries = document.entries;
    entries.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(DependencyProducerRegistry {
        schema_version: document.schema_version,
        registry_version: document.registry_version,
        entries,
    })
}

/// Check the registry against the actual functions that call the typed
/// Dependency Edge writer in each producer module. The policy entry list is
/// deliberately not the source of truth for this set: adding, removing, or
/// renaming a producer function without changing the registry must fail
/// closed. Other direct calls to the low-level helper (fixtures, Repair, and
/// Derived-State rebuild code) are not declaration producers and are kept out
/// of the two modules scanned here.
fn validate_dependency_producer_traceability(entries: &[DependencyProducerEntry]) -> Result<()> {
    let sources = [
        (
            "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
            REPOSITORY_SOURCE,
        ),
        (
            "src-tauri/crates/grimodex-db/src/narrative_extraction/legacy_backfill.rs",
            LEGACY_BACKFILL_SOURCE,
        ),
    ];
    let mut discovered = Vec::new();
    for (module, source) in sources {
        for (symbol, id) in source_dependency_producer_writers(source)? {
            discovered.push((module, symbol, id));
        }
    }
    ensure!(
        discovered.len() == entries.len(),
        "NEX_PRODUCER_REGISTRY_INVALID: discovered {} declaration writers but registry has {}",
        discovered.len(),
        entries.len()
    );
    for (module, symbol, id) in discovered {
        let matches = entries.iter().filter(|entry| {
            entry.id == id && entry.writer.module == module && entry.writer.symbol == symbol
        });
        ensure!(
            matches.count() == 1,
            "NEX_PRODUCER_REGISTRY_INVALID: source writer '{module}:{symbol}' marker '{id}' is missing or duplicated in registry"
        );
    }
    for entry in entries {
        ensure!(
            sources
                .iter()
                .any(|(module, _)| *module == entry.writer.module),
            "NEX_PRODUCER_REGISTRY_INVALID: writer '{}' points outside scanned producer modules",
            entry.id
        );
    }
    Ok(())
}

/// Discover declaration producers from source text. This intentionally uses
/// a small Rust-aware brace walk rather than a substring-only symbol check so
/// a documentation mention or a test fixture cannot satisfy traceability.
fn source_dependency_producer_writers(source: &str) -> Result<Vec<(String, String)>> {
    let lines: Vec<&str> = source.lines().collect();
    let mut marked = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        let Some(id) = trimmed.strip_prefix(PRODUCER_MARKER_PREFIX) else {
            continue;
        };
        ensure!(
            !id.trim().is_empty(),
            "NEX_PRODUCER_REGISTRY_INVALID: empty producer traceability marker"
        );
        let next_index = index + 1;
        let symbol = lines
            .get(next_index)
            .copied()
            .and_then(rust_function_name)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_PRODUCER_REGISTRY_INVALID: producer marker '{id}' is not attached to a function"
                )
            })?;
        ensure!(
            function_contains_edge_writer_call(&lines, next_index),
            "NEX_PRODUCER_REGISTRY_INVALID: producer marker '{id}' does not guard a typed Edge writer"
        );
        marked.push((symbol.to_string(), id.trim().to_string()));
    }

    let mut discovered = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(symbol) = rust_function_name(line) else {
            continue;
        };
        if !function_contains_edge_writer_call(&lines, index) {
            continue;
        }
        let marker = index
            .checked_sub(1)
            .and_then(|previous| lines.get(previous).copied())
            .and_then(|previous| previous.trim().strip_prefix(PRODUCER_MARKER_PREFIX));
        let Some(id) = marker else {
            return Err(anyhow::anyhow!(
                "NEX_PRODUCER_REGISTRY_INVALID: typed Edge writer '{symbol}' has no traceability marker"
            ));
        };
        discovered.push((symbol.to_string(), id.trim().to_string()));
    }
    ensure!(
        marked.len() == discovered.len(),
        "NEX_PRODUCER_REGISTRY_INVALID: producer markers and typed Edge writers differ"
    );
    for writer in &marked {
        ensure!(
            discovered.iter().filter(|candidate| *candidate == writer).count() == 1,
            "NEX_PRODUCER_REGISTRY_INVALID: producer marker does not uniquely identify a typed Edge writer"
        );
    }
    Ok(discovered)
}

fn rust_function_name(line: &str) -> Option<&str> {
    let mut remaining = line.trim_start();
    for visibility in [
        "pub(crate) ",
        "pub(super) ",
        "pub ",
        "const ",
        "async ",
        "unsafe ",
    ] {
        if let Some(stripped) = remaining.strip_prefix(visibility) {
            remaining = stripped;
        }
    }
    let remaining = remaining.strip_prefix("fn ")?;
    let end = remaining
        .find(|character: char| !(character == '_' || character.is_ascii_alphanumeric()))?;
    let name = &remaining[..end];
    (!name.is_empty()).then_some(name)
}

fn function_contains_edge_writer_call(lines: &[&str], start: usize) -> bool {
    let mut depth = 0usize;
    let mut opened = false;
    let mut body = String::new();
    for line in lines.iter().skip(start) {
        for character in line.chars() {
            match character {
                '{' => {
                    opened = true;
                    depth += 1;
                }
                '}' if opened => {
                    depth = depth.saturating_sub(1);
                }
                _ => {}
            }
        }
        if opened {
            body.push_str(line);
            body.push('\n');
            if depth == 0 {
                return body.contains("record_dependency_edge_in_tx(");
            }
        }
    }
    false
}

/// Compute all current coordinates in one call so a caller cannot mix values
/// from different bundled contract versions.
pub fn current_maintenance_coordinates() -> Result<MaintenanceContractCoordinates> {
    let graph_contract = json!({
        "contractVersion": "narrative-dependency-graph/v1",
        "sourceIdentityPrefixes": SOURCE_IDENTITY_PREFIXES,
        "consumerKinds": [
            RUN_CONSUMER_KIND,
            PROPOSAL_REVISION_CONSUMER_KIND,
            APPLICATION_CONSUMER_KIND
        ],
        "edgeColumns": [
            "projectId", "consumerKind", "consumerKey", "sourceObjectIdentity",
            "readSetJson", "generatedByTransactionId", "owningRunId"
        ],
        "readSetShape": "json-array-of-revision-tokens",
        "declarationWriteAuthority": "producer-transaction"
    });
    let graph_contract_digest = domain_digest(GRAPH_CONTRACT_DOMAIN, &graph_contract)?;

    let finding_registry = bundled_finding_rule_registry()?;
    let rule_registry_digest =
        domain_digest(FINDING_RULE_DOMAIN, &finding_registry.canonical_value()?)?;

    let producer_registry = bundled_dependency_producer_registry()?;
    let producer_generation_set_digest = producer_generation_set_digest(&producer_registry)?;

    Ok(MaintenanceContractCoordinates {
        graph_contract_digest,
        rule_registry_digest,
        producer_generation_set_digest,
    })
}

fn producer_generation_set_digest(registry: &DependencyProducerRegistry) -> Result<String> {
    let mut entries = registry.entries().to_vec();
    entries.sort_by(|left, right| left.id.cmp(&right.id));
    domain_digest(PRODUCER_GENERATION_DOMAIN, &serde_json::to_value(entries)?)
}

fn domain_digest(domain: &str, value: &serde_json::Value) -> Result<String> {
    let canonical = serde_json::to_vec(&(domain, value))?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(canonical))))
}

/// Derive the deterministic, test-only mismatch value for one Rust-owned
/// coordinate. The baseline coordinate is read from the current executable
/// contract; JavaScript never supplies either the baseline or the resulting
/// digest. Keeping the target name in the domain-separated input makes each
/// trigger stable while ensuring it cannot accidentally reuse another target's
/// value.
pub fn derive_ci_coordinate_mismatch_digest(
    coordinate_name: &str,
    baseline: &str,
) -> Result<String> {
    ensure!(
        !coordinate_name.trim().is_empty(),
        "coordinate name is required"
    );
    ensure!(
        baseline.starts_with("sha256:") && baseline.len() == "sha256:".len() + 64,
        "baseline coordinate must be a canonical sha256 digest"
    );
    domain_digest(
        CI_COORDINATE_MISMATCH_DOMAIN,
        &json!({
            "coordinate": coordinate_name,
            "baseline": baseline,
        }),
    )
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

    #[test]
    fn proposal_revision_d1_generation_drift_fails_closed() {
        let mut document: serde_json::Value =
            serde_json::from_str(BUNDLED_PRODUCER_REGISTRY).expect("registry JSON");
        document["entries"]
            .as_array_mut()
            .expect("entries")
            .iter_mut()
            .find(|entry| entry["id"] == "proposal-revision-source-basis")
            .expect("proposal revision producer")["declarationSetGeneration"] =
            serde_json::json!(2);

        let error = parse_dependency_producer_registry(&document.to_string())
            .expect_err("a drifted D1 declaration generation must fail closed");
        assert!(error.to_string().contains("declarationSetGeneration"));
    }
}
