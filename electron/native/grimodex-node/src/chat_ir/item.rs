//! The selection of the answer, the projection of one candidate to an item, and
//! the canonical form of an item.
//!
//! The selection is a copy of the rule of Related Scenes' `scoring::run`
//! (DR-CHATIR-S1-17: S1-A does not touch the live path): rank by score
//! descending, then Scene ID, revision ID and evidence ID; drop what is below
//! the floor; one item per Scene; stop at the cap. The order and the floor are
//! decided on the score as computed. Only the output rounds it.

use std::collections::HashSet;

use anyhow::{anyhow, ensure, Result};
use grimodex_semantic::audit::sha256_hex;
use serde::Deserialize;
use serde_json::{json, Value};

/// A summary is cut to this many characters (Unicode scalar values) plus `…`.
/// The quote is already cut by the evidence handle (180 characters plus `…`).
/// Lowering either is a technical decision; raising one needs a confirmation
/// (the approval covers a summary and a quote, DR-CHATIR-S1-21).
pub(crate) const SUMMARY_MAX_CHARS: usize = 400;

/// The mark that tells the audit replacement (S1-C) that an object is an IR
/// item of this path.
pub(crate) const IR_MARK: &str = "$grimodexIr";
pub(crate) const ORIGIN: &str = "chronicle-ir";

/// One admitted evidence of one admitted revision with its score.
#[derive(Clone, Debug)]
pub(crate) struct Candidate<'a> {
    pub(crate) score: f32,
    pub(crate) scene_id: &'a str,
    pub(crate) revision_id: &'a str,
    pub(crate) evidence_id: &'a str,
    /// The serialized statement (`chronicle-semantic-retrieval/1`:
    /// `{summary, actuality, attribution, narrativeFrame}`). Only `summary` is
    /// read; the other fields are never copied into an item (the approval is
    /// "summary and quote", not the properties).
    pub(crate) statement: &'a str,
    pub(crate) quote: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct IrItem {
    pub(crate) value: Value,
    pub(crate) digest: String,
    pub(crate) byte_length: usize,
    pub(crate) revision_id: String,
    pub(crate) scene_id: String,
    pub(crate) scene_title: String,
    pub(crate) score: f64,
    pub(crate) generation: i64,
}

/// Exactly the fields of the statement that may leave. A struct without
/// `deny_unknown_fields`: the other fields are dropped by construction.
#[derive(Deserialize)]
struct StatementSummary {
    summary: String,
}

pub(crate) fn project_summary(statement: &str) -> Result<String> {
    let parsed: StatementSummary =
        serde_json::from_str(statement).map_err(|_| anyhow!("CHAT_IR_STATEMENT_INVALID"))?;
    let mut summary: String = parsed.summary.chars().take(SUMMARY_MAX_CHARS).collect();
    if parsed.summary.chars().count() > SUMMARY_MAX_CHARS {
        summary.push('…');
    }
    Ok(summary)
}

/// The score as it appears in the item and its digest: four decimals.
pub(crate) fn rounded_score(score: f32) -> f64 {
    (f64::from(score) * 10_000.0).round() / 10_000.0
}

/// `title_of` returns `None` for a Scene that no longer has a title row (it was
/// archived or deleted since); such a candidate is skipped without taking the
/// Scene's place.
pub(crate) fn select_items<'a>(
    mut candidates: Vec<Candidate<'a>>,
    floor: f64,
    cap: usize,
    generation: i64,
    mut title_of: impl FnMut(&str) -> Result<Option<String>>,
) -> Result<Vec<IrItem>> {
    ensure!(
        candidates
            .iter()
            .all(|candidate| candidate.score.is_finite()),
        "CHAT_IR_SCORE_INVALID"
    );
    candidates.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.scene_id.cmp(b.scene_id))
            .then(a.revision_id.cmp(b.revision_id))
            .then(a.evidence_id.cmp(b.evidence_id))
    });
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for candidate in candidates {
        if items.len() >= cap {
            break;
        }
        if f64::from(candidate.score) < floor {
            continue;
        }
        if seen.contains(candidate.scene_id) {
            continue;
        }
        let Some(title) = title_of(candidate.scene_id)? else {
            continue;
        };
        seen.insert(candidate.scene_id);
        items.push(build_item(&candidate, title, generation)?);
    }
    Ok(items)
}

fn build_item(candidate: &Candidate<'_>, title: String, generation: i64) -> Result<IrItem> {
    let summary = project_summary(candidate.statement)?;
    let score = rounded_score(candidate.score);
    let value = json!({
        IR_MARK: 1,
        "origin": ORIGIN,
        "revisionId": candidate.revision_id,
        "sceneId": candidate.scene_id,
        "sceneTitle": title,
        "summary": summary,
        "quote": candidate.quote,
        "score": score,
        "generation": generation,
    });
    let canonical = canonical_json(&value);
    Ok(IrItem {
        digest: sha256_hex(canonical.as_bytes()),
        byte_length: canonical.len(),
        revision_id: candidate.revision_id.to_string(),
        scene_id: candidate.scene_id.to_string(),
        scene_title: title,
        score,
        generation,
        value,
    })
}

/// The canonical text of a JSON value, the input of an item's digest (S1-C
/// computes the same from the value Native passes): object keys in code point
/// order; a number with an integer value as an integer, any other as its
/// shortest f64 text; a string as serde escapes it; no whitespace.
pub(crate) fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                out.push_str(&number.to_string());
            } else {
                match number.as_f64() {
                    Some(float)
                        if float.is_finite() && float.fract() == 0.0 && float.abs() < 9.0e15 =>
                    {
                        out.push_str(&format!("{}", float as i64));
                    }
                    _ => out.push_str(&number.to_string()),
                }
            }
        }
        Value::String(text) => {
            out.push_str(&serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string()));
        }
        Value::Array(values) => {
            out.push('[');
            for (index, element) in values.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(element, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()));
                out.push(':');
                write_canonical(&map[key], out);
            }
            out.push('}');
        }
    }
}

/// The wire object of the answer's `items` (a plain list of the item values).
pub(crate) fn items_wire(items: &[IrItem]) -> Value {
    Value::Array(items.iter().map(|item| item.value.clone()).collect())
}
