//! Versioned V2 material/context projection for Prepare, Apply and dependencies.
//! No synthetic V1 fields are added to the immutable revision envelope.

use std::collections::{BTreeMap, HashSet};

use anyhow::{anyhow, ensure};
use rusqlite::Connection;
use serde_json::Value;

use super::reconciliation_envelope::SourceBasisRow;
use super::nir1_entity_relation_index::{GraphWorkControl, NeverStopGraphWorkControl};
use super::source_revision::{
    resolve_source_revision_with_control, ValidationContext,
};
use super::stage_provenance::{load_v2_context_artifact, VerifiedV2ContextArtifact};

pub(crate) fn ensure_supported_intent(envelope: &Value) -> anyhow::Result<()> {
    ensure!(
        matches!(
            envelope
                .pointer("/revisionBasis/kind")
                .and_then(Value::as_str),
            Some("interpretation" | "human-derived")
        ),
        "NEX_V2_APPLY_BASIS_UNSUPPORTED: only interpretation and human-derived are supported"
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
#[allow(dead_code)]
pub(crate) fn load_v2_apply_sources(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    revision_id: &str,
    envelope: &Value,
) -> anyhow::Result<Vec<SourceBasisRow>> {
    let mut control = NeverStopGraphWorkControl;
    load_v2_apply_sources_with_control(
        conn,
        project_id,
        run_id,
        revision_id,
        envelope,
        &mut control,
    )
}

/// V2 source loading under the owner of the enclosing Prepare/Apply
/// transaction.  The ordinary helper above remains for bounded legacy/test
/// callers, but production whole-eligibility paths use this variant so a
/// lifecycle stop is preserved as a typed termination rather than a stale
/// Source result.
pub(crate) fn load_v2_apply_sources_with_control(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    revision_id: &str,
    envelope: &Value,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<Vec<SourceBasisRow>> {
    ensure_supported_intent(envelope)?;
    control.check(super::nir1_entity_relation_index::GraphWorkStage::Source)?;
    // AI が出したままの版は、その版自身を受領書と文脈の検査の対象にする。
    // 作者が編集した版（human-derived）は、系譜が最初の AI の版まで通ることを
    // 確かめ、受領書と文脈の検査を最初の AI の版に対して行う（DR-ERA-2/3）。
    let root = if is_human_derived(envelope) {
        Some(load_verified_root(conn, project_id, revision_id)?)
    } else {
        None
    };
    let artifact = match &root {
        None => load_v2_context_artifact(conn, project_id, run_id, revision_id, envelope)?,
        Some(root) => {
            load_v2_context_artifact(conn, project_id, run_id, &root.revision_id, &root.envelope)?
        }
    };
    if let Some(root) = &root {
        validate_root_coverage(root, &artifact)?;
    }
    let mut sources = BTreeMap::new();
    for entry in array(envelope, "/effectiveMaterialBasis/sourceBasis")? {
        let source_key = string(entry, "sourceKey")?;
        let source_kind = string(entry, "sourceKind")?;
        let revision_token = string(entry, "revisionToken")?;
        let current = resolve_source_revision_with_control(
            conn,
            project_id,
            run_id,
            source_kind,
            source_key,
            control,
        )?;
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
    if root.is_none() {
        validate_coverage(envelope, &artifact, &sources)?;
    }
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

/// 最初の AI の版の文脈と依存の対応は、その版自身の材料（記録された token のまま）に
/// 対して検査する。取り込む版の材料を渡すと、開示の項目を変えた版の材料が orphan に
/// なり必ず拒まれる。編集した版の形は系譜の検証が確かめる（DR-ERA-2）。
fn validate_root_coverage(
    root: &VerifiedRoot,
    artifact: &VerifiedV2ContextArtifact,
) -> anyhow::Result<()> {
    #[cfg(test)]
    ROOT_COVERAGE_CHECKS.with(|count| count.set(count.get() + 1));
    let mut root_sources = BTreeMap::new();
    for entry in array(&root.envelope, "/effectiveMaterialBasis/sourceBasis")? {
        let source_key = string(entry, "sourceKey")?;
        ensure!(
            root_sources
                .insert(
                    source_key.to_owned(),
                    SourceBasisRow {
                        ordinal: 0,
                        source_kind: string(entry, "sourceKind")?.to_owned(),
                        source_key: source_key.to_owned(),
                        revision_token: string(entry, "revisionToken")?.to_owned(),
                        observed_at: None,
                    }
                )
                .is_none(),
            "NEX_V2_READ_COVERAGE_INVALID: duplicate source"
        );
    }
    ensure!(
        !root_sources.is_empty(),
        "NEX_V2_READ_COVERAGE_INVALID: source basis is empty"
    );
    validate_coverage(&root.envelope, artifact, &root_sources)
}

#[cfg(test)]
thread_local! {
    /// 編集した版の分岐が、最初の AI の版の文脈の検査を通った回数（試験専用）。
    static ROOT_COVERAGE_CHECKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn is_human_derived(envelope: &Value) -> bool {
    envelope
        .pointer("/revisionBasis/kind")
        .and_then(Value::as_str)
        == Some("human-derived")
}

/// 編集した版から最初の AI の版までの系譜を検証した結果。
struct VerifiedRoot {
    revision_id: String,
    envelope: Value,
}

/// 系譜の検証（関連場面の資格と同じ検証）を通して、最初の AI の版を得る。
/// 通らないときは `NEX_V2_APPLY_LINEAGE_INVALID` で拒む。DB の読み書きの
/// エラー（rusqlite）は、そのまま伝える。最初の版の材料の再生は呼ばない。
fn load_verified_root(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
) -> anyhow::Result<VerifiedRoot> {
    match super::material_membership::read_lineage_root_for_apply(conn, project_id, revision_id) {
        Ok(Some((revision_id, envelope))) => Ok(VerifiedRoot {
            revision_id,
            envelope,
        }),
        Ok(None) => Err(anyhow!(
            "NEX_V2_APPLY_LINEAGE_INVALID: revision '{revision_id}' was not found"
        )),
        Err(error) => {
            if error.downcast_ref::<rusqlite::Error>().is_some() {
                return Err(error);
            }
            Err(anyhow!("NEX_V2_APPLY_LINEAGE_INVALID: {error:#}"))
        }
    }
}

/// Context-coupled V2 loader for Prepare/Apply.  The same transaction that
/// performs the writer's DML owns both the connection and lifecycle scope.
pub(crate) fn load_v2_apply_sources_with_validation_context(
    context: &mut ValidationContext<'_, '_>,
    project_id: &str,
    run_id: &str,
    revision_id: &str,
    envelope: &Value,
) -> anyhow::Result<Vec<SourceBasisRow>> {
    let conn = context.connection();
    load_v2_apply_sources_with_control(
        conn,
        project_id,
        run_id,
        revision_id,
        envelope,
        context.control(),
    )
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
        // 作者が編集した版（human-derived）は、種類の検査では通る。系譜の検証は
        // 別の段（load_v2_apply_sources_with_control）で行う。
        let mut envelope = valid.clone();
        envelope["revisionBasis"]["kind"] = json!("human-derived");
        ensure_supported_intent(&envelope).expect("human-derived add");
        // 知らない版の種類は拒む。
        for kind in [json!("unknown"), json!("ai-derived"), Value::Null] {
            let mut envelope = valid.clone();
            envelope["revisionBasis"]["kind"] = kind;
            let error = ensure_supported_intent(&envelope).expect_err("unknown basis");
            assert!(error.to_string().contains("NEX_V2_APPLY_BASIS_UNSUPPORTED"));
        }
        // human-derived でも add 以外の変更の種類は拒む。
        let mut envelope = valid;
        envelope["revisionBasis"]["kind"] = json!("human-derived");
        envelope["changeIntent"]["changeKind"] = json!("retract");
        assert!(ensure_supported_intent(&envelope).is_err());
    }

    fn root_of(envelope: &Value) -> VerifiedRoot {
        // 最初の AI の版は、自身の材料（sourceBasis）を持つ。
        let mut envelope = envelope.clone();
        envelope["effectiveMaterialBasis"]["sourceBasis"] = json!([
            {"sourceKey":"project:scene:s1", "sourceKind":"scene-body", "revisionToken":"v1"}
        ]);
        VerifiedRoot {
            revision_id: "root-revision".into(),
            envelope,
        }
    }

    #[test]
    fn root_coverage_accepts_a_valid_first_revision() {
        let (envelope, artifact, _) = fixture();
        validate_root_coverage(&root_of(&envelope), &artifact).expect("valid root");
    }

    #[test]
    fn root_coverage_rejects_contract_orphan_and_empty_material() {
        let (envelope, artifact, _) = fixture();
        // 部品の契約（component-contract）の digest が、受領書の基準と合わない。
        let mut root = root_of(&envelope);
        root.envelope["effectiveMaterialBasis"]["dependencySet"][3]["selector"]["contractDigest"] =
            json!("wrong");
        assert!(
            validate_root_coverage(&root, &artifact).is_err(),
            "contract digest"
        );
        // どの依存からも参照されない材料（orphan）。
        let mut root = root_of(&envelope);
        root.envelope["effectiveMaterialBasis"]["sourceBasis"]
            .as_array_mut()
            .expect("sourceBasis")
            .push(json!({"sourceKey":"project:scene:orphan", "sourceKind":"scene-body", "revisionToken":"v1"}));
        assert!(
            validate_root_coverage(&root, &artifact).is_err(),
            "orphan material"
        );
        // 材料が空。
        let mut root = root_of(&envelope);
        root.envelope["effectiveMaterialBasis"]["sourceBasis"] = json!([]);
        let error = validate_root_coverage(&root, &artifact).expect_err("empty material");
        assert!(error.to_string().contains("source basis is empty"));
        // 重複した材料。
        let mut root = root_of(&envelope);
        let duplicate = root.envelope["effectiveMaterialBasis"]["sourceBasis"][0].clone();
        root.envelope["effectiveMaterialBasis"]["sourceBasis"]
            .as_array_mut()
            .expect("sourceBasis")
            .push(duplicate);
        assert!(
            validate_root_coverage(&root, &artifact).is_err(),
            "duplicate material"
        );
    }

    /// 実際の DB（cold fixture の複製）で、編集した版（human-derived）の分岐が
    /// 最初の AI の版の文脈の検査を必ず通ることと、AI が出したままの版は通らないことを固定する。
    #[test]
    fn human_derived_branch_runs_the_root_coverage_check_and_the_interpretation_branch_does_not() {
        use std::io::Read;
        let manifest: Value = serde_json::from_str(include_str!(
            "../../tests/support/nir1-reviewed-child-cold.json"
        ))
        .expect("cold fixture manifest");
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(
            &include_bytes!("../../tests/support/nir1-reviewed-child-cold.db.gz")[..],
        )
        .read_to_end(&mut bytes)
        .expect("cold fixture bytes");
        let path = std::env::temp_dir().join(format!(
            "grimodex-v2-apply-sources-{}.db",
            uuid_like_suffix()
        ));
        std::fs::write(&path, bytes).expect("private fixture copy");
        let db = crate::Database::new(&path).expect("private fixture database");
        let project = manifest["projectId"].as_str().expect("project");
        let run = manifest["runId"].as_str().expect("run");
        let load = |revision: &str| {
            db.with_conn(|conn| {
                let raw: String = conn.query_row(
                    "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id = ?1",
                    [revision],
                    |row| row.get(0),
                )?;
                let envelope: Value = serde_json::from_str(&raw)?;
                let tx = conn.unchecked_transaction()?;
                let before = ROOT_COVERAGE_CHECKS.with(|count| count.get());
                let rows = load_v2_apply_sources(&tx, project, run, revision, &envelope);
                let after = ROOT_COVERAGE_CHECKS.with(|count| count.get());
                Ok((rows.map(|rows| rows.len()), after - before))
            })
            .expect("loader call")
        };
        let child = manifest["revisionIds"][0].as_str().expect("child");
        let root = manifest["rootRevisionIds"][0].as_str().expect("root");
        let (rows, checks) = load(child);
        assert!(rows.is_ok(), "edited revision loads: {rows:?}");
        assert_eq!(
            checks, 1,
            "the human-derived branch must check the root coverage"
        );
        let (rows, checks) = load(root);
        assert!(rows.is_ok(), "AI revision loads: {rows:?}");
        assert_eq!(
            checks, 0,
            "the interpretation branch checks its own coverage instead"
        );
        drop(db);
        let _ = std::fs::remove_file(&path);
        for suffix in ["-wal", "-shm"] {
            let mut sidecar = path.as_os_str().to_os_string();
            sidecar.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(sidecar));
        }
    }

    fn uuid_like_suffix() -> String {
        format!(
            "{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        )
    }
}
