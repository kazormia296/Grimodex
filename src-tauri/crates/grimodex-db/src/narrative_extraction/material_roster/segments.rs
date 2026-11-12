//! Port of spanCatalog buildAliasManifest/buildWindowSegments for one request
//! window. Every context gap and unselected span is retained.
//!
//! The catalog proof and each document's UTF-16 text are built once per
//! snapshot (`SnapshotSegments`), never once per window and receipt.
use super::{array_at, string_at};
use anyhow::{ensure, Result};
use grimodex_core::canonical_json_digest;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

#[derive(Clone, Debug, Serialize)]
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

fn slice_units(units: &[u16], start: usize, end: usize) -> Result<String> {
    let range = units
        .get(start..end)
        .ok_or_else(|| anyhow::anyhow!("range outside text"))?;
    Ok(String::from_utf16(range)?)
}
#[cfg(test)]
pub(super) fn utf16_slice(text: &str, start: usize, end: usize) -> Result<String> {
    slice_units(&text.encode_utf16().collect::<Vec<_>>(), start, end)
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

/// The catalog checks that read only the snapshot: recipe, own digest,
/// snapshot binding and unique source refs across every entry.
fn verify_catalog(snapshot: &Value) -> Result<()> {
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
    let mut seen = BTreeSet::new();
    for entry in array_at(catalog, "/entries")? {
        ensure!(
            seen.insert(string_at(entry, "/sourceRef")?),
            "duplicate catalog ref"
        );
    }
    Ok(())
}

struct CatalogRange {
    start: usize,
    end: usize,
    source_ref: String,
}

/// One document seen through every window over it: its text as UTF-16 units
/// and the catalog entries that belong to it, text-checked once.
struct DocumentText {
    units: Vec<u16>,
    entries: Vec<CatalogRange>,
}

impl DocumentText {
    /// Only the entries of this one document are text-checked, as before: a
    /// document no window reads is never verified.
    fn build(snapshot: &Value, document: &Value, document_ref: &Value) -> Result<Self> {
        let units: Vec<u16> = string_at(document, "/canonical/text")?
            .encode_utf16()
            .collect();
        let mut entries = vec![];
        for entry in array_at(&snapshot["evidence"]["catalog"], "/entries")? {
            if entry["documentRef"] != *document_ref {
                continue;
            }
            let (start, end) = range(&entry["canonicalRange"])?;
            ensure!(
                slice_units(&units, start, end)? == string_at(entry, "/quote")?,
                "catalog-text-mismatch"
            );
            entries.push(CatalogRange {
                start,
                end,
                source_ref: string_at(entry, "/sourceRef")?,
            });
        }
        Ok(Self { units, entries })
    }
}

/// Verified catalog and document texts of ONE snapshot. Only successes are
/// kept, so a failure is raised again by the next read. The owner must drop
/// this value when the snapshot changes.
#[derive(Default)]
pub(super) struct SnapshotSegments {
    catalog_verified: bool,
    documents: HashMap<String, DocumentText>,
}

impl SnapshotSegments {
    pub(super) fn observation(
        &mut self,
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
        let document_key = window["documentRef"].to_string();
        if !self.documents.contains_key(&document_key) {
            if !self.catalog_verified {
                verify_catalog(snapshot)?;
                self.catalog_verified = true;
            }
            let built = DocumentText::build(snapshot, document, &window["documentRef"])?;
            self.documents.insert(document_key.clone(), built);
        }
        let doc = self
            .documents
            .get(&document_key)
            .ok_or_else(|| anyhow::anyhow!("document text missing"))?;
        ensure!(
            slice_units(&doc.units, start, end)? == text,
            "source-view-text-mismatch"
        );
        let catalog = &snapshot["evidence"]["catalog"];
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
        let mut visible: Vec<&CatalogRange> = vec![];
        for entry in &doc.entries {
            if entry.start < end && entry.end > start {
                boundaries.insert(entry.start.max(start));
                boundaries.insert(entry.end.min(end));
            }
            if entry.start >= start && entry.end <= end {
                visible.push(entry);
            }
        }
        // The first visible entry with exactly this range wins, as before.
        let mut exact: HashMap<(usize, usize), usize> = HashMap::new();
        for (index, entry) in visible.iter().enumerate() {
            exact.entry((entry.start, entry.end)).or_insert(index);
        }
        let mut rows = vec![];
        let mut materials = vec![];
        let mut joined = String::new();
        let mut document_strings: Option<(String, String, String)> = None;
        let points: Vec<_> = boundaries.into_iter().collect();
        for pair in points.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if a == b {
                continue;
            }
            let content = slice_units(&doc.units, a, b)?;
            let (kind, source_ref) = if let Some(&index) = exact.get(&(a, b)) {
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
                ("span", Some(visible[index].source_ref.clone()))
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
            if document_strings.is_none() {
                document_strings = Some((
                    string_at(document, "/sourceKey")?,
                    string_at(document, "/ref")?,
                    string_at(document, "/artifactDigest")?,
                ));
            }
            let Some((source_key, document_ref, artifact_digest)) = document_strings.as_ref()
            else {
                anyhow::bail!("document strings missing");
            };
            materials.push(Material {
                kind,
                context_id: format!("observation-citation-window:{window_id}"),
                input_ref: format!("citation-window:{window_id}"),
                request_execution_id: string_at(execution, "/stageExecutionId")?,
                source_key: source_key.clone(),
                document_ref: document_ref.clone(),
                document_artifact_digest: artifact_digest.clone(),
                canonical_range: json!({"start":a,"end":b}),
                canonical_source_ref: source_ref,
                content_digest: canonical_json_digest(&json!(content))?,
            });
        }
        ensure!(joined == text, "segment-roster-incomplete");
        let digests = super::prompt::replay(
            super::prompt::OBSERVATION,
            &string_at(receipt, "/componentContractDigest")?,
            vec![(
                format!("observation-citation-window:{window_id}"),
                format!("citation-window:{window_id}"),
                rows.join("\n"),
            )],
        )?;
        Ok((digests, materials))
    }
}

/// The one-shot form for tests that read a single window.
#[cfg(test)]
pub(super) fn observation(
    snapshot: &Value,
    window: &Value,
    receipt: &Value,
) -> Result<(super::prompt::Digests, Vec<Material>)> {
    SnapshotSegments::default().observation(snapshot, window, receipt)
}
