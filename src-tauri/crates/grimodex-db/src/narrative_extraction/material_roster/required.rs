//! Bind the selected request and effective declarations to snapshot windows.
//! A source declared by the sealed basis remains required even when none of
//! its observations were selected. The reader never rewrites that basis.
use super::{array_at, string_at};
use anyhow::{ensure, Result};
use serde_json::Value;
use std::collections::BTreeSet;

pub(super) fn windows(
    envelope: &Value,
    snapshot: &Value,
    windows: &[Value],
    selected_ids: &[String],
) -> Result<BTreeSet<String>> {
    let contexts = array_at(envelope, "/revisionBasis/contextSet")?
        .iter()
        .map(|c| string_at(c, "/contextId"))
        .collect::<Result<BTreeSet<_>>>()?;
    let dependencies = array_at(envelope, "/effectiveMaterialBasis/dependencySet")?;
    let sources = array_at(envelope, "/effectiveMaterialBasis/sourceBasis")?;
    let documents = array_at(snapshot, "/snapshot/documents")?;
    let mut declared = BTreeSet::new();
    for source in sources.iter().filter(|s| s["sourceKind"] == "scene-body") {
        let key = string_at(source, "/sourceKey")?;
        ensure!(declared.insert(key.clone()), "duplicate-story-source");
        let declarations = dependencies
            .iter()
            .filter(|d| d["inputRef"] == key)
            .collect::<Vec<_>>();
        ensure!(!declarations.is_empty(), "story-source-declaration-missing");
        for declaration in declarations {
            let ids = array_at(declaration, "/contextIds")?;
            ensure!(
                ["direct-evidence", "opaque-model-context"]
                    .iter()
                    .any(|role| declaration["role"] == *role)
                    && declaration["selector"]["kind"] == "whole-source"
                    && !ids.is_empty()
                    && ids
                        .iter()
                        .all(|id| id.as_str().is_some_and(|id| contexts.contains(id))),
                "story-source-request-declaration-invalid"
            );
        }
        let docs = documents
            .iter()
            .filter(|d| d["sourceKey"] == key)
            .collect::<Vec<_>>();
        ensure!(docs.len() == 1, "declared-source-document-binding-invalid");
        let origin = &docs[0]["origin"];
        ensure!(
            origin["kind"] == "project-node"
                && key == format!("project:scene:{}", string_at(origin, "/nodeId")?)
                && source["revisionToken"]
                    == format!(
                        "v{}@{}",
                        origin["sourceVersion"]
                            .as_u64()
                            .ok_or_else(|| anyhow::anyhow!("source version"))?,
                        string_at(origin, "/sourceUpdatedAt")?
                    ),
            "declared-source-snapshot-revision-mismatch"
        );
    }
    ensure!(!declared.is_empty(), "story-source-roster-empty");
    let mut required = BTreeSet::new();
    let mut covered = BTreeSet::new();
    for window in windows {
        let id = string_at(window, "/windowId")?;
        let docs = documents
            .iter()
            .filter(|d| d["ref"] == window["documentRef"])
            .collect::<Vec<_>>();
        ensure!(docs.len() == 1, "window-document-binding-invalid");
        let key = string_at(docs[0], "/sourceKey")?;
        let selected = selected_ids
            .iter()
            .any(|o| o.starts_with(&format!("{id}:")));
        ensure!(
            !selected || declared.contains(&key),
            "selected-request-source-undeclared"
        );
        if declared.contains(&key) {
            covered.insert(key);
            required.insert(id);
        }
    }
    ensure!(covered == declared, "declared-source-window-missing");
    Ok(required)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn golden() -> Value {
        serde_json::from_str(include_str!("production-two-window-golden.json"))
            .expect("production golden")
    }
    #[test]
    fn declarations_retain_the_unselected_request_without_making_run_membership_a_dependency() {
        let g = golden();
        let plan = array_at(&g, "/plan/windows").expect("windows");
        let selected = vec!["window-002:obs-001".to_owned()];
        assert_eq!(
            windows(&g["rootEnvelope"], &g["snapshot"], plan, &selected).expect("required windows"),
            BTreeSet::from(["window-001".into(), "window-002".into()])
        );
        // Exercise only this selector with a separate hypothetical declaration.
        // It is deliberately not a resealed or accepted membership fixture.
        let mut declaration = g["rootEnvelope"].clone();
        let extra = "project:scene:en-distractor-gift";
        for field in ["sourceBasis", "dependencySet"] {
            declaration["effectiveMaterialBasis"][field]
                .as_array_mut()
                .expect("array")
                .retain(|row| row["sourceKey"] != extra && row["inputRef"] != extra);
        }
        assert_eq!(
            windows(&declaration, &g["snapshot"], plan, &selected)
                .expect("unbound Run input is not required"),
            BTreeSet::from(["window-002".into()])
        );
    }
    #[test]
    fn a_sealed_story_source_cannot_be_dropped_for_a_missing_or_foreign_request_declaration() {
        let g = golden();
        for corrupt_context in [false, true] {
            let mut envelope = g["rootEnvelope"].clone();
            let declarations = envelope["effectiveMaterialBasis"]["dependencySet"]
                .as_array_mut()
                .expect("declarations");
            if corrupt_context {
                declarations
                    .iter_mut()
                    .find(|d| d["inputRef"] == "project:scene:en-distractor-gift")
                    .expect("extra declaration")["contextIds"] =
                    serde_json::json!(["event-observation:another-run"]);
            } else {
                declarations.retain(|d| d["inputRef"] != "project:scene:en-distractor-gift");
            }
            assert!(windows(
                &envelope,
                &g["snapshot"],
                array_at(&g, "/plan/windows").expect("windows"),
                &["window-002:obs-001".into()]
            )
            .is_err());
        }
    }
}
