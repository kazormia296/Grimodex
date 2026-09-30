use anyhow::{ensure, Result};
use grimodex_core::canonical_json_digest;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::retrieval_admission::{
    build::BuildCandidate, read_retrieval_scene_source, RetrievalSceneSourceBinding,
    RetrievalSceneSourceRead,
};

pub(super) struct VerifiedEvidence {
    pub evidence_id: String,
    pub scene_id: String,
    pub quote: String,
    pub start_utf16: usize,
    pub end_utf16: usize,
    pub source: RetrievalSceneSourceBinding,
}

/// Retain only exact source/range/quote bindings from an already verified
/// artifact. No mutable event-ID navigation or prefix-search range fallback.
pub(super) fn read_verified_evidence(
    conn: &Connection,
    project: &str,
    candidate: &BuildCandidate,
) -> Result<Vec<VerifiedEvidence>> {
    let mut artifacts = Vec::new();
    for (id, expected_digest) in &candidate.evidence_artifacts {
        let row = conn
            .query_row(
                "SELECT a.payload_json,a.payload_digest FROM narrative_extraction_artifacts a
            JOIN narrative_extraction_runs r ON r.id=a.run_id WHERE a.id=?1 AND a.run_id=?2
            AND r.project_id=?3 AND a.artifact_kind='evidence.resolved@1'",
                params![id, candidate.owning_run_id, project],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()?;
        let Some((Some(payload), Some(digest))) = row else {
            anyhow::bail!("NIR1 verified Evidence artifact missing");
        };
        let payload: Value = serde_json::from_str(&payload)?;
        ensure!(
            digest == *expected_digest && canonical_json_digest(&payload)? == digest,
            "NIR1 Evidence artifact digest changed"
        );
        artifacts.push(payload);
    }
    let mut verified = Vec::new();
    for evidence in &candidate.evidence {
        let Some(scene) = evidence
            .source_key
            .strip_prefix("project:scene:")
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        if !candidate.sources.iter().any(|source| {
            source.source_kind == "scene-body"
                && source.source_key == evidence.source_key
                && source.revision_token == evidence.revision_token
        }) {
            continue;
        }
        let RetrievalSceneSourceRead::Available(source) =
            read_retrieval_scene_source(conn, project, scene)?
        else {
            continue;
        };
        if source.archived
            || source.query_source.revision_token != evidence.revision_token
            || evidence.quote.is_empty()
            || evidence.quote_digest
                != format!(
                    "sha256:{}",
                    hex::encode(Sha256::digest(evidence.quote.as_bytes()))
                )
        {
            continue;
        }
        let anchors = artifacts
            .iter()
            .filter_map(|artifact| artifact["anchors"].as_array())
            .flatten()
            .filter(|anchor| {
                anchor["id"] == evidence.evidence_ref
                    && anchor["documentRef"] == evidence.document_ref
                    && anchor["quote"] == evidence.quote
                    && anchor["quoteDigest"] == evidence.quote_digest
            })
            .collect::<Vec<_>>();
        if anchors.len() != 1 {
            continue;
        }
        let Some(start) = anchors[0]["canonicalRange"]["start"]
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
        else {
            continue;
        };
        let Some(end) = anchors[0]["canonicalRange"]["end"]
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
        else {
            continue;
        };
        if !exact_utf16_quote(&source.canonical_source_text, &evidence.quote, start, end) {
            continue;
        }
        verified.push(VerifiedEvidence {
            evidence_id: evidence.evidence_ref.clone(),
            scene_id: scene.into(),
            quote: evidence.quote.clone(),
            start_utf16: start,
            end_utf16: end,
            source: source.query_source,
        });
    }
    Ok(verified)
}

pub(super) fn exact_utf16_quote(text: &str, quote: &str, start: usize, end: usize) -> bool {
    if quote.is_empty() || start >= end || end - start != quote.encode_utf16().count() {
        return false;
    }
    let units = text.encode_utf16().collect::<Vec<_>>();
    units
        .get(start..end)
        .is_some_and(|range| String::from_utf16(range).is_ok_and(|value| value == quote))
}
