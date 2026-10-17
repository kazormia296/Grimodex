//! P-12 baseline arm (evaluation feature only; DP-H, K6/2 "P-12 の baseline
//! arm").
//!
//! The selection is a port of `selectContextItems`
//! (`src/features/ai-context/budgetSelector.ts`): remove one item at a time in
//! ascending (authority rank, priority, original order) until the measure (the
//! sum of the kept items' estimated tokens) is within the budget. The items
//! are the candidate set the packer was given (each item is its own group).
//! Rendering goes through the same renderer entry as the candidate arm
//! (`render_local_plain_chat_payload`), once, on the renderer input that the
//! product function `build_native_nir1_prepared_inputs` builds from the kept
//! items. The baseline never reads or writes the database and its payload is
//! never sent or stored by this module.

use anyhow::{anyhow, Result};
use grimodex_core::narrative_nir1::PackingPurpose;
use grimodex_db::narrative_extraction::final_request_eval as db_eval;
use serde_json::{json, Map, Value};

use super::capture::{
    input_reference_json, qualification_json, render_correspondence_json, CapturedRequest,
    DfinalOutcome,
};
use crate::nir1_prepared_request::render_local_plain_chat_payload;

/// The measure of both arms (the sum of the kept items' estimated tokens).
pub const MEASURE: &str = "item-estimate-sum";

/// Authority rank (lower yields first) and priority of a kind, from the table
/// of `nir1Packing.ts` (`authorityForKind`, `priorityForKind`) and
/// `AUTHORITY_RETENTION_RANK` of `budgetSelector.ts`.
fn kind_table(kind: &str) -> Option<(u8, i64)> {
    // episodic 0, retrieved 1, derived 2, canonical 3, author_instruction 4
    match kind {
        "raw" => Some((4, 100)),
        "accepted-ir" => Some((3, 80)),
        "graph-evidence" => Some((2, 70)),
        "author-declared" => Some((3, 60)),
        "unreviewed-for-review" => Some((0, 10)),
        _ => None,
    }
}

/// One selectable item: its key, its kind and its estimated tokens.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectionItem {
    pub key: String,
    pub kind: String,
    pub tokens: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectionDecision {
    pub key: String,
    pub selected: bool,
    pub tokens_before: usize,
    pub tokens_after: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Selection {
    /// Kept keys in the original order.
    pub selected_keys: Vec<String>,
    pub decisions: Vec<SelectionDecision>,
    pub candidate_tokens: usize,
    pub selected_tokens: usize,
    pub trimmed_tokens: usize,
    pub budget_tokens: usize,
}

fn sum_tokens(items: &[SelectionItem], removed: &[bool]) -> Result<usize> {
    items
        .iter()
        .zip(removed)
        .filter(|(_, removed)| !**removed)
        .try_fold(0usize, |total, (item, _)| {
            total
                .checked_add(item.tokens)
                .ok_or_else(|| anyhow!("NIR1_EVAL_BASELINE_TOKEN_OVERFLOW"))
        })
}

/// The pure selection (the port of `selectContextItems` with the measure of
/// the sum of item estimates). Raw is removed last, and also removed when Raw
/// alone exceeds the budget; `raw_exceeds_budget` is the check that turns that
/// case into a typed result before this function is used.
pub fn select_context_items(items: &[SelectionItem], budget_tokens: usize) -> Result<Selection> {
    let mut rank = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let (authority_rank, priority) = kind_table(&item.kind)
            .ok_or_else(|| anyhow!("NIR1_EVAL_BASELINE_KIND_UNKNOWN: {}", item.kind))?;
        rank.push((authority_rank, priority, index));
    }
    let mut removed = vec![false; items.len()];
    let candidate_tokens = sum_tokens(items, &removed)?;
    if candidate_tokens > budget_tokens {
        rank.sort();
        for (_, _, index) in rank {
            if sum_tokens(items, &removed)? <= budget_tokens {
                break;
            }
            removed[index] = true;
        }
    }
    let selected_tokens = sum_tokens(items, &removed)?;
    let decisions = items
        .iter()
        .zip(&removed)
        .map(|(item, removed)| SelectionDecision {
            key: item.key.clone(),
            selected: !removed,
            tokens_before: item.tokens,
            tokens_after: if *removed { 0 } else { item.tokens },
        })
        .collect::<Vec<_>>();
    Ok(Selection {
        selected_keys: items
            .iter()
            .zip(&removed)
            .filter(|(_, removed)| !**removed)
            .map(|(item, _)| item.key.clone())
            .collect(),
        decisions,
        candidate_tokens,
        selected_tokens,
        trimmed_tokens: candidate_tokens.saturating_sub(selected_tokens),
        budget_tokens,
    })
}

/// Raw alone does not fit the budget (the typed "input reduction required"
/// result of the candidate packer and the TS packing path).
pub fn raw_exceeds_budget(items: &[SelectionItem], budget_tokens: usize) -> bool {
    items
        .iter()
        .filter(|item| item.kind == "raw")
        .fold(0usize, |total, item| total.saturating_add(item.tokens))
        > budget_tokens
}

// ---------------------------------------------------------------- the arm

/// The typed result of a baseline arm. Only `Rendered` has a payload.
#[derive(Clone)]
#[allow(clippy::large_enum_variant)] // One value per request; boxing would only obscure the receipt shape.
pub(crate) enum BaselineOutcome {
    Rendered {
        payload: String,
        payload_digest: String,
        render_correspondence: Value,
        input_references: Value,
        qualifications: Value,
    },
    /// The selection does not satisfy the renderer's premises (Raw 1, accepted
    /// IR 1 or more, qualification complete). Nothing was rendered.
    Unrenderable { reason: String },
    /// Raw alone exceeds the context budget. Nothing was selected.
    InputReductionRequired { raw_tokens: usize, budget: usize },
    /// The rendered request exceeded the route's context window.
    WindowExceeded { reason: String },
}

pub(crate) struct BaselineResult {
    pub(crate) outcome: BaselineOutcome,
    /// The item-level selection (absent when Raw alone exceeded the budget).
    pub(crate) selection: Option<Selection>,
}

/// The baseline arm was asked for a request it must not run on.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BaselineRefused {
    pub(crate) reason: &'static str,
}

fn selection_items(captured: &CapturedRequest) -> Vec<SelectionItem> {
    let writing = captured.candidate_set.purpose == PackingPurpose::Writing;
    captured
        .candidate_set
        .items
        .iter()
        // `purposeExcludedIds`: Writing never carries unreviewed material,
        // for either arm.
        .filter(|row| !(writing && row.kind == "unreviewed-for-review"))
        .map(|row| SelectionItem {
            key: row.item_id.clone(),
            kind: row.kind.to_owned(),
            tokens: row.tokens,
        })
        .collect()
}

/// Run the baseline arm on the capture of a request D-final answered with Ok.
/// An Err request, an Ok whose digest differs from the capture, and a capture
/// that is not the D-final capture are refused (draft: those requests are
/// neither scored nor given a baseline).
pub(crate) fn run_baseline_arm(
    captured: &CapturedRequest,
    dfinal: &DfinalOutcome,
) -> std::result::Result<BaselineResult, BaselineRefused> {
    match dfinal {
        DfinalOutcome::Ok { payload_digest } if *payload_digest == captured.payload_digest => {}
        DfinalOutcome::Ok { .. } => {
            return Err(BaselineRefused {
                reason: "dfinal-digest-differs-from-capture",
            })
        }
        DfinalOutcome::Err { .. } => {
            return Err(BaselineRefused {
                reason: "dfinal-did-not-return-ok",
            })
        }
    }
    if !captured.candidate_set.pooled_source_path {
        return Err(BaselineRefused {
            reason: "capture-is-not-a-dfinal-capture",
        });
    }
    let items = selection_items(captured);
    let budget = captured.context_budget_tokens;
    if raw_exceeds_budget(&items, budget) {
        let raw_tokens = items
            .iter()
            .filter(|item| item.kind == "raw")
            .fold(0usize, |total, item| total.saturating_add(item.tokens));
        return Ok(BaselineResult {
            outcome: BaselineOutcome::InputReductionRequired { raw_tokens, budget },
            selection: None,
        });
    }
    let selection = match select_context_items(&items, budget) {
        Ok(selection) => selection,
        Err(error) => {
            return Ok(BaselineResult {
                outcome: BaselineOutcome::Unrenderable {
                    reason: error.to_string(),
                },
                selection: None,
            })
        }
    };
    let kept_accepted_ir = captured
        .candidate_set
        .items
        .iter()
        .filter(|row| row.kind == "accepted-ir")
        .filter(|row| selection.selected_keys.contains(&row.item_id))
        .count();
    let kept_raw = captured
        .candidate_set
        .items
        .iter()
        .filter(|row| row.kind == "raw")
        .filter(|row| selection.selected_keys.contains(&row.item_id))
        .count();
    if kept_raw != 1 || kept_accepted_ir == 0 {
        // The renderer's premises are not changed for the baseline: nothing is
        // rendered for a selection that leaves no accepted IR (or no Raw).
        let reason = if kept_raw != 1 {
            "raw-missing"
        } else {
            "accepted-ir-missing"
        };
        return Ok(BaselineResult {
            outcome: BaselineOutcome::Unrenderable {
                reason: reason.to_owned(),
            },
            selection: Some(selection),
        });
    }
    let outcome = render(captured, &selection);
    Ok(BaselineResult {
        outcome,
        selection: Some(selection),
    })
}

fn render(captured: &CapturedRequest, selection: &Selection) -> BaselineOutcome {
    let prepared = match db_eval::prepared_inputs_for_baseline(
        &captured.candidate_set,
        &captured.render_base,
        &selection.selected_keys,
    ) {
        Ok(prepared) => prepared,
        Err(error) => {
            return BaselineOutcome::Unrenderable {
                reason: error.to_string(),
            }
        }
    };
    match render_local_plain_chat_payload(
        &captured.route,
        &prepared,
        captured.context_budget_tokens,
        &mut || Ok(()),
    ) {
        Ok(rendered) => BaselineOutcome::Rendered {
            payload: rendered.canonical_payload,
            payload_digest: rendered.payload_digest,
            render_correspondence: render_correspondence_json(&rendered.render_correspondence),
            input_references: Value::Array(
                rendered
                    .input_references
                    .iter()
                    .map(input_reference_json)
                    .collect(),
            ),
            qualifications: Value::Array(
                rendered
                    .qualifications
                    .iter()
                    .map(|qualification| {
                        qualification_json(qualification, Some(qualification.input_ordinal))
                    })
                    .collect(),
            ),
        },
        Err(error) => {
            let message = error.to_string();
            if message.starts_with("NIR1_PREPARED_CONTEXT_WINDOW_EXCEEDED") {
                BaselineOutcome::WindowExceeded { reason: message }
            } else {
                BaselineOutcome::Unrenderable { reason: message }
            }
        }
    }
}

impl BaselineResult {
    /// The `baseline` arm of a receipt request. `persisted_rows` is the number
    /// of attempt or receipt rows the harness measured the baseline call to
    /// have added (the arm itself touches no database).
    pub(crate) fn arm_json(&self, captured: &CapturedRequest, persisted_rows: u64) -> Value {
        let mut arm = Map::new();
        arm.insert("arm".into(), json!("baseline"));
        arm.insert("persistedRows".into(), json!(persisted_rows));
        match &self.outcome {
            BaselineOutcome::Rendered {
                payload,
                payload_digest,
                render_correspondence,
                input_references,
                qualifications,
            } => {
                arm.insert("outcome".into(), json!("rendered"));
                arm.insert("payload".into(), json!(payload));
                arm.insert("payloadDigest".into(), json!(payload_digest));
                arm.insert("renderCorrespondence".into(), render_correspondence.clone());
                arm.insert("inputReferences".into(), input_references.clone());
                arm.insert("qualifications".into(), qualifications.clone());
                arm.insert("inputs".into(), captured.same_input_json());
                // DP-H material is Raw and accepted IR only: no Graph Evidence
                // exists to be boosted, so no qualified Evidence is counted.
                arm.insert("counters".into(), json!({ "qualifiedEvidence": 0 }));
            }
            BaselineOutcome::Unrenderable { reason } => {
                arm.insert("outcome".into(), json!("unrenderable"));
                arm.insert("reason".into(), json!(reason));
            }
            BaselineOutcome::InputReductionRequired { raw_tokens, budget } => {
                arm.insert("outcome".into(), json!("input-reduction-required"));
                arm.insert(
                    "reason".into(),
                    json!(format!(
                        "raw {raw_tokens} tokens exceed the budget {budget}"
                    )),
                );
            }
            BaselineOutcome::WindowExceeded { reason } => {
                arm.insert("outcome".into(), json!("window-exceeded"));
                arm.insert("reason".into(), json!(reason));
            }
        }
        Value::Object(arm)
    }
}
