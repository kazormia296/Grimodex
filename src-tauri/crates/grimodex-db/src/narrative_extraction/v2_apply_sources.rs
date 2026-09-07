//! Versioned V2 material/context projection for Prepare, Apply and dependencies.
//! No synthetic V1 fields are added to the immutable revision envelope.

use std::collections::{BTreeMap, HashSet};

use anyhow::{anyhow, ensure};
use rusqlite::Connection;
use serde_json::Value;

use super::reconciliation_envelope::SourceBasisRow;
use super::source_revision::resolve_source_revision;
use super::stage_provenance::{load_v2_context_artifact, VerifiedV2ContextArtifact};

pub(crate) fn ensure_supported_intent(envelope: &Value) -> anyhow::Result<()> {
    ensure!(
        envelope
            .pointer("/revisionBasis/kind")
            .and_then(Value::as_str)
            == Some("interpretation"),
        "NEX_V2_APPLY_BASIS_UNSUPPORTED: only interpretation is supported"
    );
    ensure!(
        envelope
            .pointer("/changeIntent/changeKind")
            .and_then(Value::as_str)
            == Some("add"),
        "NEX_NARRATIVE_V2_PILOT_CHANGE_KIND_FORBIDDEN: production Chronicle pilot accepts only add"
    );
    Ok(())
}

fn string<'a>(value: &'a Value, field: &str) -> anyhow::Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("NEX_V2_READ_COVERAGE_INVALID: {field} is missing"))
}

fn array<'a>(envelope: &'a Value, pointer: &str) -> anyhow::Result<&'a Vec<Value>> {
    envelope
        .pointer(pointer)
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("NEX_V2_READ_COVERAGE_INVALID: {pointer} is missing"))
}

/// Call only after the existing schema, canonical envelope and nested digest
/// validation. Every dynamic declaration must resolve, including non-model
/// context; static contracts are checked separately against the durable receipt.
pub(crate) fn load_v2_apply_sources(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    revision_id: &str,
    envelope: &Value,
) -> anyhow::Result<Vec<SourceBasisRow>> {
    ensure_supported_intent(envelope)?;
    let artifact = load_v2_context_artifact(conn, project_id, run_id, revision_id, envelope)?;
    let mut sources = BTreeMap::new();
    for entry in array(envelope, "/effectiveMaterialBasis/sourceBasis")? {
        let source_key = string(entry, "sourceKey")?;
        let source_kind = string(entry, "sourceKind")?;
        let revision_token = string(entry, "revisionToken")?;
        let current = resolve_source_revision(conn, project_id, run_id, source_kind, source_key)?;
        ensure!(
            current.revision_token == revision_token,
            "NEX_READ_SET_STALE: V2 material source changed"
        );
        ensure!(
            sources
                .insert(
                    source_key.to_owned(),
                    SourceBasisRow {
                        ordinal: 0,
                        source_kind: source_kind.to_owned(),
                        source_key: source_key.to_owned(),
                        revision_token: revision_token.to_owned(),
                        observed_at: None,
                    }
                )
                .is_none(),
            "NEX_V2_READ_COVERAGE_INVALID: duplicate source"
        );
    }
    ensure!(
        !sources.is_empty(),
        "NEX_V2_READ_COVERAGE_INVALID: source basis is empty"
    );
    validate_coverage(envelope, &artifact, &sources)?;
    let artifact_row = SourceBasisRow {
        ordinal: 0,
        source_kind: "narrative-artifact".to_owned(),
        source_key: artifact.source_key.clone(),
        revision_token: artifact.revision_token,
        observed_at: None,
    };
    if let Some(existing) = sources.get(&artifact.source_key) {
        ensure!(
            existing.source_kind == artifact_row.source_kind
                && existing.revision_token == artifact_row.revision_token,
            "NEX_V2_READ_COVERAGE_INVALID: companion source conflicts with material"
        );
    } else {
        sources.insert(artifact.source_key, artifact_row);
    }
    sources
        .into_values()
        .enumerate()
        .map(|(ordinal, mut row)| {
            row.ordinal = i64::try_from(ordinal)?;
            Ok(row)
        })
        .collect()
}

fn validate_coverage(
    envelope: &Value,
    artifact: &VerifiedV2ContextArtifact,
    sources: &BTreeMap<String, SourceBasisRow>,
) -> anyhow::Result<()> {
    let resolves = |input: &str| {
        sources.contains_key(input)
            || input
                .strip_prefix("cluster:")
                .is_some_and(|id| id == artifact.cluster_ref)
            || input
                .strip_prefix("observation:")
                .is_some_and(|id| artifact.observation_refs.iter().any(|known| known == id))
    };
    let contexts = array(envelope, "/revisionBasis/contextSet")?;
    let dependencies = array(envelope, "/effectiveMaterialBasis/dependencySet")?;
    let mut context_ids = HashSet::new();
    for context in contexts {
        let id = string(context, "contextId")?;
        let input = string(context, "inputRef")?;
        ensure!(
            context_ids.insert(id) && resolves(input),
            "NEX_V2_READ_COVERAGE_INVALID: duplicate or unsupported context"
        );
        ensure!(
            dependencies.iter().any(|dependency| dependency
                .get("inputRef")
                .and_then(Value::as_str)
                == Some(input)
                && dependency.get("selector") == context.get("selector")
                && dependency
                    .get("contextIds")
                    .and_then(Value::as_array)
                    .is_some_and(|ids| ids.iter().any(|known| known.as_str() == Some(id)))),
            "NEX_V2_READ_COVERAGE_INVALID: context has no matching dependency"
        );
    }
    let mut dependency_ids = HashSet::new();
    let mut component_count = 0;
    for dependency in dependencies {
        ensure!(
            dependency_ids.insert(string(dependency, "dependencyId")?),
            "NEX_V2_READ_COVERAGE_INVALID: duplicate dependency"
        );
        let input = string(dependency, "inputRef")?;
        for id in array(dependency, "/contextIds")? {
            ensure!(
                id.as_str().is_some_and(|id| context_ids.contains(id)),
                "NEX_V2_READ_COVERAGE_INVALID: dependency context is missing"
            );
        }
        if string(dependency, "role")? == "component-contract" {
            component_count += 1;
            let selector = dependency
                .get("selector")
                .ok_or_else(|| anyhow!("NEX_V2_READ_COVERAGE_INVALID: selector missing"))?;
            ensure!(
                string(selector, "kind")? == "component-contract"
                    && input == format!("component:{}", string(selector, "contractId")?)
                    && selector.get("contractDigest")
                        == envelope.pointer("/revisionBasis/componentContractDigest"),
                "NEX_V2_READ_COVERAGE_INVALID: component contract differs from receipt basis"
            );
        } else {
            ensure!(
                dependency.pointer("/selector/kind").and_then(Value::as_str)
                    != Some("component-contract")
                    && resolves(input),
                "NEX_V2_READ_COVERAGE_INVALID: unsupported dynamic dependency"
            );
        }
    }
    ensure!(
        component_count == 1,
        "NEX_V2_READ_COVERAGE_INVALID: expected one component contract"
    );
    for evidence in array(envelope, "/effectiveMaterialBasis/evidenceSet")? {
        let source = sources
            .get(string(evidence, "sourceKey")?)
            .ok_or_else(|| anyhow!("NEX_V2_READ_COVERAGE_INVALID: evidence source is missing"))?;
        ensure!(
            source.revision_token == string(evidence, "revisionToken")?,
            "NEX_V2_READ_COVERAGE_INVALID: evidence token differs from source"
        );
    }
    for source in sources.values() {
        ensure!(
            dependencies.iter().any(|dependency| dependency
                .get("inputRef")
                .and_then(Value::as_str)
                == Some(source.source_key.as_str())),
            "NEX_V2_READ_COVERAGE_INVALID: orphan material source"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (
        Value,
        VerifiedV2ContextArtifact,
        BTreeMap<String, SourceBasisRow>,
    ) {
        let context = |id: &str, input: &str| {
            json!({"contextId": id, "inputRef": input,
            "selector": {"kind":"whole-source"}, "exposure":"model-visible"})
        };
        let dependency = |id: &str, input: &str, ids: Vec<&str>| {
            json!({"dependencyId":id,
            "inputRef":input, "contextIds":ids, "role":"opaque-model-context", "selector":{"kind":"whole-source"}})
        };
        let envelope = json!({
            "revisionBasis":{"kind":"interpretation", "componentContractDigest":"contract-digest", "contextSet":[
                context("cluster", "cluster:c1"), context("observation", "observation:o1"), context("scene", "project:scene:s1")
            ]},
            "changeIntent":{"changeKind":"add"},
            "effectiveMaterialBasis":{
                "evidenceSet":[{"sourceKey":"project:scene:s1", "revisionToken":"v1"}],
                "dependencySet":[dependency("cluster", "cluster:c1", vec!["cluster"]),
                    dependency("observation", "observation:o1", vec!["observation"]),
                    dependency("scene", "project:scene:s1", vec!["scene"]),
                    {"dependencyId":"contract", "inputRef":"component:prompt", "contextIds":[], "role":"component-contract",
                     "selector":{"kind":"component-contract", "contractId":"prompt", "contractDigest":"contract-digest"}}]
            }
        });
        let artifact = VerifiedV2ContextArtifact {
            source_key: "artifact:a1".into(),
            revision_token: "a1-digest".into(),
            cluster_ref: "c1".into(),
            observation_refs: vec!["o1".into()],
        };
        let sources = BTreeMap::from([(
            "project:scene:s1".into(),
            SourceBasisRow {
                ordinal: 0,
                source_key: "project:scene:s1".into(),
                source_kind: "scene-body".into(),
                revision_token: "v1".into(),
                observed_at: None,
            },
        )]);
        (envelope, artifact, sources)
    }

    #[test]
    fn covers_material_and_both_typed_context_aliases() {
        let (envelope, artifact, sources) = fixture();
        ensure_supported_intent(&envelope).expect("pilot add");
        validate_coverage(&envelope, &artifact, &sources)
            .expect("complete live and artifact coverage");
    }

    #[test]
    fn rejects_unresolved_or_inconsistent_material_context_and_static_contract() {
        let (valid, artifact, sources) = fixture();
        for (pointer, replacement) in [
            (
                "/revisionBasis/contextSet/0/inputRef",
                json!("cluster:another-task"),
            ),
            (
                "/revisionBasis/contextSet/1/inputRef",
                json!("observation:unknown"),
            ),
            (
                "/revisionBasis/contextSet/2/inputRef",
                json!("unsupported:context"),
            ),
            ("/revisionBasis/contextSet/1/contextId", json!("cluster")),
            (
                "/effectiveMaterialBasis/dependencySet/0/inputRef",
                json!("cluster:unknown"),
            ),
            (
                "/effectiveMaterialBasis/dependencySet/1/contextIds",
                json!(["missing"]),
            ),
            (
                "/effectiveMaterialBasis/dependencySet/1/dependencyId",
                json!("cluster"),
            ),
            (
                "/effectiveMaterialBasis/dependencySet/1/selector",
                json!({"kind":"component-contract"}),
            ),
            (
                "/effectiveMaterialBasis/dependencySet/3/selector/contractDigest",
                json!("wrong"),
            ),
            (
                "/effectiveMaterialBasis/dependencySet/3/inputRef",
                json!("component:other"),
            ),
            (
                "/effectiveMaterialBasis/evidenceSet/0/sourceKey",
                json!("project:scene:foreign"),
            ),
            (
                "/effectiveMaterialBasis/evidenceSet/0/revisionToken",
                json!("v2"),
            ),
        ] {
            let mut envelope = valid.clone();
            *envelope.pointer_mut(pointer).expect("fixture path") = replacement;
            assert!(
                validate_coverage(&envelope, &artifact, &sources).is_err(),
                "accepted {pointer}"
            );
        }
        let mut envelope = valid.clone();
        envelope["effectiveMaterialBasis"]["dependencySet"]
            .as_array_mut()
            .expect("dependencies")
            .pop();
        assert!(
            validate_coverage(&envelope, &artifact, &sources).is_err(),
            "missing static contract"
        );
        let mut orphan_sources = sources.clone();
        let mut orphan = sources.values().next().expect("source").clone();
        orphan.source_key = "project:scene:orphan".into();
        orphan_sources.insert(orphan.source_key.clone(), orphan);
        assert!(
            validate_coverage(&valid, &artifact, &orphan_sources).is_err(),
            "orphan material"
        );
    }

    #[test]
    fn rejects_unsupported_basis_and_intent_without_defaulting_to_add() {
        let (valid, _, _) = fixture();
        for intent in [
            json!("retract"),
            json!("patch"),
            json!("unknown"),
            Value::Null,
        ] {
            let mut envelope = valid.clone();
            envelope["changeIntent"]["changeKind"] = intent;
            assert!(ensure_supported_intent(&envelope).is_err());
        }
        let mut envelope = valid;
        envelope["revisionBasis"]["kind"] = json!("human-derived");
        assert!(ensure_supported_intent(&envelope).is_err());
    }
}
