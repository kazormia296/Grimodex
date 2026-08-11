//! Shared Codex relation label normalization and semantic_key builders.
//!
//! Mirrors `buildCodexRelationSemanticKey` in relationVocabulary.ts.
//! Used by SCHEMA v7 migrate backfill and narrative apply writers.

use unicode_normalization::UnicodeNormalization;

pub fn normalize_relation_label(label: &str) -> String {
    let nfc: String = label.nfc().collect();
    let trimmed = nfc.trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut prev_space = false;
    for ch in trimmed.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out
}

/// Canonical uniqueness key for Codex relations.
/// Directed keeps endpoint order; symmetric sorts endpoints.
pub fn build_codex_relation_semantic_key(
    project_id: &str,
    from_codex_id: &str,
    to_codex_id: &str,
    relation_type: &str,
    directionality: &str,
    forward_label: &str,
    inverse_label: Option<&str>,
) -> String {
    let relation_type = normalize_relation_label(relation_type);
    let forward = normalize_relation_label(forward_label);
    let inverse = normalize_relation_label(inverse_label.unwrap_or(""));
    if directionality == "symmetric" {
        let (left, right) = if from_codex_id <= to_codex_id {
            (from_codex_id, to_codex_id)
        } else {
            (to_codex_id, from_codex_id)
        };
        let label = if forward.is_empty() {
            inverse
        } else {
            forward
        };
        format!("s\t{project_id}\t{left}\t{right}\t{relation_type}\t{label}")
    } else {
        format!(
            "d\t{project_id}\t{from_codex_id}\t{to_codex_id}\t{relation_type}\t{forward}\t{inverse}"
        )
    }
}
