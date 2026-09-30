//! Port of spanCatalog buildAliasManifest/buildWindowSegments for one request
//! window. Every context gap and unselected span is retained.
use super::{array_at, string_at};
use anyhow::{ensure, Result};
use grimodex_core::canonical_json_digest;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub kind: &'static str,
    pub context_id: String,
    pub input_ref: String,
    pub request_execution_id: String,
    pub source_key: String,
    pub document_ref: String,
    pub document_artifact_digest: String,
    pub canonical_range: Value,
    pub canonical_source_ref: Option<String>,
    pub content_digest: String,
}

pub(super) fn utf16_slice(text: &str, start: usize, end: usize) -> Result<String> {
    let units: Vec<_> = text.encode_utf16().collect();
    let range = units
        .get(start..end)
        .ok_or_else(|| anyhow::anyhow!("range outside text"))?;
    Ok(String::from_utf16(range)?)
}
fn range(v: &Value) -> Result<(usize, usize)> {
    let start = v["start"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("range start"))? as usize;
    let end = v["end"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("range end"))? as usize;
    ensure!(start <= end, "range reversed");
    Ok((start, end))
}

pub(super) fn observation(
    snapshot: &Value,
    window: &Value,
    receipt: &Value,
) -> Result<(super::prompt::Digests, Vec<Material>)> {
    let view = array_at(snapshot, "/sourceViews")?
        .iter()
        .filter(|v| v["ref"] == window["sourceRef"])
        .collect::<Vec<_>>();
    ensure!(view.len() == 1, "window-source-view-binding-invalid");
    let view = view[0];
    ensure!(
        view["documentRef"] == window["documentRef"],
        "window-document-mismatch"
    );
    let docs = array_at(snapshot, "/snapshot/documents")?
        .iter()
        .filter(|d| d["ref"] == window["documentRef"])
        .collect::<Vec<_>>();
    ensure!(docs.len() == 1, "window-document-binding-invalid");
    let document = docs[0];
    let (start, end) = range(&view["documentRange"])?;
    let text = string_at(view, "/text")?;
    ensure!(
        utf16_slice(&string_at(document, "/canonical/text")?, start, end)? == text,
        "source-view-text-mismatch"
    );
    let catalog = &snapshot["evidence"]["catalog"];
    ensure!(
        catalog["version"] == 1 && catalog["segmentationVersion"] == "sentence-like-v1",
        "unknown catalog recipe"
    );
    let mut catalog_input = catalog.clone();
    catalog_input
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("catalog shape"))?
        .remove("digest");
    ensure!(
        canonical_json_digest(&catalog_input)? == string_at(catalog, "/digest")?,
        "catalog-digest-mismatch"
    );
    ensure!(
        catalog["snapshotDigest"] == snapshot["snapshot"]["digest"]
            && catalog["snapshotArtifactDigest"] == snapshot["snapshot"]["artifactDigest"],
        "catalog-snapshot-binding-invalid"
    );
    let execution = &receipt["stageExecution"];
    let window_id = string_at(window, "/windowId")?;
    let identity = format!(
        "run:{}:task:{}:attempt:{}:window:{window_id}",
        string_at(execution, "/runId")?,
        string_at(execution, "/taskId")?,
        string_at(execution, "/attemptId")?
    );
    let digest = canonical_json_digest(
        &json!({"requestIdentity":identity,"catalogDigest":catalog["digest"],
        "snapshotArtifactDigest":catalog["snapshotArtifactDigest"],"windows":[{"windowId":window_id,
        "documentRef":window["documentRef"],"sourceViewRef":view["ref"],"documentRange":view["documentRange"]}]}),
    )?;
    let token = digest
        .get(7..19)
        .ok_or_else(|| anyhow::anyhow!("digest format"))?;
    let mut boundaries = BTreeSet::from([start, end]);
    let mut visible = vec![];
    let mut seen = BTreeSet::new();
    for entry in array_at(catalog, "/entries")? {
        ensure!(
            seen.insert(string_at(entry, "/sourceRef")?),
            "duplicate catalog ref"
        );
        if entry["documentRef"] != window["documentRef"] {
            continue;
        }
        let (a, b) = range(&entry["canonicalRange"])?;
        ensure!(
            utf16_slice(&string_at(document, "/canonical/text")?, a, b)?
                == string_at(entry, "/quote")?,
            "catalog-text-mismatch"
        );
        if a < end && b > start {
            boundaries.insert(a.max(start));
            boundaries.insert(b.min(end));
        }
        if a >= start && b <= end {
            visible.push((entry, a, b));
        }
    }
    let mut rows = vec![];
    let mut materials = vec![];
    let mut joined = String::new();
    let points: Vec<_> = boundaries.into_iter().collect();
    for pair in points.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if a == b {
            continue;
        }
        let exact = visible
            .iter()
            .enumerate()
            .find(|(_, (_, x, y))| *x == a && *y == b);
        let content = utf16_slice(&text, a - start, b - start)?;
        let (kind, source_ref) = if let Some((index, (entry, _, _))) = exact {
            // Struct field order is deliberately kind,text,evidenceRef, matching
            // JSON.stringify. Value object sorting would alter the request bytes.
            #[derive(Serialize)]
            struct Span<'a> {
                kind: &'a str,
                text: &'a str,
                #[serde(rename = "evidenceRef")]
                evidence_ref: String,
            }
            rows.push(serde_json::to_string(&Span {
                kind: "span",
                text: &content,
                evidence_ref: format!("E{token}-{:03}", index + 1),
            })?);
            ("span", Some(string_at(entry, "/sourceRef")?))
        } else {
            #[derive(Serialize)]
            struct Context<'a> {
                kind: &'a str,
                text: &'a str,
            }
            rows.push(serde_json::to_string(&Context {
                kind: "context",
                text: &content,
            })?);
            ("context", None)
        };
        joined.push_str(&content);
        materials.push(Material {
            kind,
            context_id: format!("observation-citation-window:{window_id}"),
            input_ref: format!("citation-window:{window_id}"),
            request_execution_id: string_at(execution, "/stageExecutionId")?,
            source_key: string_at(document, "/sourceKey")?,
            document_ref: string_at(document, "/ref")?,
            document_artifact_digest: string_at(document, "/artifactDigest")?,
            canonical_range: json!({"start":a,"end":b}),
            canonical_source_ref: source_ref,
            content_digest: canonical_json_digest(&json!(content))?,
        });
    }
    ensure!(joined == text, "segment-roster-incomplete");
    let digests = super::prompt::replay(
        super::prompt::OBSERVATION,
        vec![(
            format!("observation-citation-window:{window_id}"),
            format!("citation-window:{window_id}"),
            rows.join("\n"),
        )],
    )?;
    Ok((digests, materials))
}
