//! The (c-2) observation and the per-request record (evaluation feature only).
//!
//! `observe_rendered` is the only function the product path calls. It takes
//! the record that (c-1) wrote on this thread, checks that the record belongs
//! to the request being rendered, and keeps the result in a thread-local list.
//! It returns nothing and cannot fail the product path. `run_dfinal_with_capture`
//! is the harness entry: it empties the slots, calls D-final, and pairs the
//! return value with the capture of the same request.

use std::cell::RefCell;

use anyhow::Result;
use grimodex_db::narrative_extraction::final_request_eval::{
    self as db_eval, CandidateSetRecord, RenderBase,
};
use grimodex_db::narrative_extraction::NativeNir1PreparedInputs;
use grimodex_db::nir1_generation::{
    InputReference, InputTarget, QualificationBody, QualificationKind, QualificationReference,
};
use serde_json::{json, Map, Value};

use crate::nir1_prepared_request::{
    NativeAcceptedChatSubmission, NativePreparedRequest, PreparedPayloadPosition,
    PreparedRenderCorrespondence, RenderedLocalPlainChatPayload, SupportedLocalChatRoute,
    CHAT_SYSTEM_BASE, DATA_BOUNDARY_REMINDER, FIXED_TEMPLATE_REF, FIXED_TEMPLATE_VERSION,
};

use super::baseline::MEASURE;

/// Everything (c-1) and (c-2) observed for one rendered request. The typed
/// parts feed the baseline arm; the JSON of the receipt comes from the
/// `*_json` methods.
#[derive(Clone)]
pub(crate) struct CapturedRequest {
    pub(crate) request_token: String,
    pub(crate) captured_turn_id: String,
    pub(crate) user_message_text: String,
    pub(crate) user_message_digest_sha256: String,
    pub(crate) user_message_version_id: String,
    pub(crate) snapshot_identity: String,
    pub(crate) estimator_version: &'static str,
    pub(crate) template_version: &'static str,
    pub(crate) template_ref: &'static str,
    pub(crate) template_sha256: String,
    pub(crate) route: SupportedLocalChatRoute,
    pub(crate) context_budget_tokens: usize,
    pub(crate) passed_revision_ids: Vec<String>,
    pub(crate) candidate_set: CandidateSetRecord,
    pub(crate) payload: String,
    pub(crate) payload_digest: String,
    pub(crate) render_correspondence: Vec<PreparedRenderCorrespondence>,
    pub(crate) input_references: Vec<InputReference>,
    pub(crate) qualifications: Vec<QualificationReference>,
    pub(crate) render_base: RenderBase,
}

enum Observed {
    Captured(Box<CapturedRequest>),
    Defect(String),
}

thread_local! {
    static COMPLETED: RefCell<Vec<Observed>> = const { RefCell::new(Vec::new()) };
}

fn push_observed(observed: Observed) {
    COMPLETED.with(|list| {
        if let Ok(mut list) = list.try_borrow_mut() {
            list.push(observed);
        }
    });
}

fn drain_observed() -> Vec<Observed> {
    COMPLETED.with(|list| {
        list.try_borrow_mut()
            .map(|mut list| std::mem::take(&mut *list))
            .unwrap_or_default()
    })
}

fn template_sha256() -> String {
    // The scorer's `makeFixedTemplate`: sha256 of base, NUL, reminder.
    db_eval::sha256_hex(format!("{CHAT_SYSTEM_BASE}\u{0}{DATA_BOUNDARY_REMINDER}").as_bytes())
}

fn build_capture(
    submission: &NativeAcceptedChatSubmission,
    projection: &NativeNir1PreparedInputs,
    route: &SupportedLocalChatRoute,
    context_budget_tokens: usize,
    rendered: &RenderedLocalPlainChatPayload,
    record: CandidateSetRecord,
) -> CapturedRequest {
    CapturedRequest {
        request_token: format!("nir1-eval-request-{}", record.sequence),
        captured_turn_id: submission.capture_id().to_owned(),
        user_message_text: projection.user_message().to_owned(),
        user_message_digest_sha256: db_eval::sha256_hex(projection.user_message().as_bytes()),
        user_message_version_id: projection.user_message_version().id.clone(),
        snapshot_identity: record.snapshot_identity.clone(),
        estimator_version: grimodex_core::narrative_nir1::NIR1_CONTEXT_TOKEN_ESTIMATOR_VERSION,
        template_version: FIXED_TEMPLATE_VERSION,
        template_ref: FIXED_TEMPLATE_REF,
        template_sha256: template_sha256(),
        route: route.clone(),
        context_budget_tokens,
        passed_revision_ids: record.revision_ids.clone(),
        payload: rendered.canonical_payload.clone(),
        payload_digest: rendered.payload_digest.clone(),
        render_correspondence: rendered.render_correspondence.clone(),
        input_references: rendered.input_references.clone(),
        qualifications: rendered.qualifications.clone(),
        render_base: db_eval::render_base(projection),
        candidate_set: record,
    }
}

/// Observation call (c-2). Takes the (c-1) record of this thread and keeps a
/// capture, or a defect when the record is missing, belongs to another path,
/// or does not match the projection. Returns nothing.
pub(in crate::nir1_prepared_request) fn observe_rendered(
    submission: &NativeAcceptedChatSubmission,
    projection: &NativeNir1PreparedInputs,
    route: &SupportedLocalChatRoute,
    context_budget_tokens: &usize,
    rendered: &RenderedLocalPlainChatPayload,
) {
    let observed = match db_eval::take_candidate_set() {
        None => Observed::Defect("no (c-1) candidate set was recorded for this request".into()),
        Some(record) => {
            if let Some(error) = &record.derivation_error {
                Observed::Defect(format!("the (c-1) record is incomplete: {error}"))
            } else if let Err(reason) =
                db_eval::check_record_matches_projection(&record, projection)
            {
                Observed::Defect(reason)
            } else {
                Observed::Captured(Box::new(build_capture(
                    submission,
                    projection,
                    route,
                    *context_budget_tokens,
                    rendered,
                    record,
                )))
            }
        }
    };
    push_observed(observed);
}

// ------------------------------------------------------------------- JSON

fn role_name(reference: &InputReference) -> Value {
    serde_json::to_value(&reference.role).unwrap_or(Value::Null)
}

/// `{ role, target }` as the receipt contract spells it (no `inputUse`, no
/// null `parentAttemptId`).
pub(crate) fn input_reference_json(reference: &InputReference) -> Value {
    let mut target = serde_json::to_value(&reference.target).unwrap_or(Value::Null);
    if let Some(object) = target.as_object_mut() {
        if object.get("parentAttemptId") == Some(&Value::Null) {
            object.remove("parentAttemptId");
        }
    }
    json!({ "role": role_name(reference), "target": target })
}

/// A qualification row of the receipt contract. `ordinal` is `None` for a
/// candidate ref (the rows of a candidate carry no input ordinal).
pub(crate) fn qualification_json(
    qualification: &QualificationReference,
    ordinal: Option<usize>,
) -> Value {
    let mut row = Map::new();
    if let Some(ordinal) = ordinal {
        row.insert("inputOrdinal".into(), json!(ordinal));
    }
    row.insert(
        "kind".into(),
        serde_json::to_value(qualification.kind).unwrap_or(Value::Null),
    );
    match &qualification.body {
        QualificationBody::Present {
            identity,
            version,
            scope_role,
        } => {
            row.insert("state".into(), json!("present"));
            row.insert("identity".into(), json!(identity));
            row.insert("version".into(), json!(version));
            if let Some(role) = scope_role {
                row.insert(
                    "scopeRole".into(),
                    serde_json::to_value(role).unwrap_or(Value::Null),
                );
            }
        }
        QualificationBody::NotApplicable { reason } => {
            row.insert("state".into(), json!("not-applicable"));
            row.insert(
                "reason".into(),
                serde_json::to_value(reason).unwrap_or(Value::Null),
            );
        }
    }
    Value::Object(row)
}

pub(crate) fn render_correspondence_json(rows: &[PreparedRenderCorrespondence]) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| {
                let position = match row.position() {
                    PreparedPayloadPosition::SystemCurrentScene => {
                        json!({ "kind": "system-current-scene" })
                    }
                    PreparedPayloadPosition::SystemCodexEntry(index) => {
                        json!({ "kind": "system-codex-entry", "index": index })
                    }
                    PreparedPayloadPosition::HistoryMessage(index) => {
                        json!({ "kind": "history-message", "index": index })
                    }
                };
                json!({ "position": position, "inputOrdinal": row.input_ordinal() })
            })
            .collect(),
    )
}

pub(crate) fn route_json(route: &SupportedLocalChatRoute) -> Value {
    json!({
        "routeRevision": route.route_revision,
        "model": route.model,
        "contextWindowTokens": route.context_window_tokens,
        "outputTokens": route.output_tokens,
    })
}

impl CapturedRequest {
    pub(crate) fn template_json(&self) -> Value {
        json!({
            "version": self.template_version,
            "ref": self.template_ref,
            "sha256": self.template_sha256,
        })
    }

    /// The fields the "same input" check compares (draft: 同じ入力の検査).
    pub(crate) fn same_input_json(&self) -> Value {
        json!({
            "capturedTurnId": self.captured_turn_id,
            "userMessageDigestSha256": self.user_message_digest_sha256,
            "snapshotIdentity": self.snapshot_identity,
            "candidateSetDigest": self.candidate_set.candidate_set_digest,
            "estimatorVersion": self.estimator_version,
            "template": self.template_json(),
            "route": route_json(&self.route),
            "contextBudgetTokens": self.context_budget_tokens,
            "measure": MEASURE,
            "passedRevisionIds": self.passed_revision_ids,
        })
    }

    fn ordinal_of_owner(&self, owner_id: &str) -> Option<usize> {
        self.input_references
            .iter()
            .position(|reference| match &reference.target {
                InputTarget::AcceptedRevision { revision_id, .. } => revision_id == owner_id,
                // A Graph group's owner is its evidence reference.
                InputTarget::GraphEvidence { evidence_ref, .. } => evidence_ref == owner_id,
                _ => false,
            })
    }

    fn candidate_ref_json(&self, row: &db_eval::CandidateRefRow) -> Value {
        let mut qualifications = row
            .qualifications
            .iter()
            .map(|qualification| qualification_json(qualification, None))
            .collect::<Vec<_>>();
        // The D1 row is added by the render (`finalize_qualifications`), so
        // the product function that derived this ref never produced it. For an
        // owner that was rendered, the rendered D1 row completes the ref; an
        // owner that was not rendered has none (DR-DPH-41).
        if let Some(ordinal) = self.ordinal_of_owner(&row.owner_id) {
            qualifications.extend(
                self.qualifications
                    .iter()
                    .filter(|qualification| {
                        qualification.input_ordinal == ordinal
                            && qualification.kind == QualificationKind::D1
                    })
                    .map(|qualification| qualification_json(qualification, None)),
            );
        }
        json!({
            "ownerId": row.owner_id,
            "input": input_reference_json(&row.input),
            "qualifications": qualifications,
        })
    }

    fn candidate_item_json(row: &db_eval::CandidateItemRow) -> Value {
        let mut item = Map::new();
        item.insert("itemId".into(), json!(row.item_id));
        item.insert("kind".into(), json!(row.kind));
        item.insert("text".into(), json!(row.text));
        item.insert("tokens".into(), json!(row.tokens));
        item.insert("ownerId".into(), json!(row.owner_id));
        item.insert("bindingDigest".into(), json!(row.binding_digest));
        if row.kind != "raw" {
            item.insert("atomicGroup".into(), json!(row.atomic_group));
            item.insert("atomicPart".into(), json!(row.atomic_part));
        }
        Value::Object(item)
    }

    /// The `capture` of a receipt request (`validateCapture`).
    pub(crate) fn capture_json(&self) -> Value {
        json!({
            "requestToken": self.request_token,
            "capturedTurnId": self.captured_turn_id,
            "userMessage": {
                "text": self.user_message_text,
                "digestSha256": self.user_message_digest_sha256,
                "versionId": self.user_message_version_id,
            },
            "snapshotIdentity": self.snapshot_identity,
            "estimatorVersion": self.estimator_version,
            "template": self.template_json(),
            "route": route_json(&self.route),
            "contextBudgetTokens": self.context_budget_tokens,
            "measure": MEASURE,
            "passedRevisionIds": self.passed_revision_ids,
            "candidateSet": {
                "digest": self.candidate_set.candidate_set_digest,
                "items": self
                    .candidate_set
                    .items
                    .iter()
                    .map(Self::candidate_item_json)
                    .collect::<Vec<_>>(),
                "candidateRefs": self
                    .candidate_set
                    .candidate_refs
                    .iter()
                    .map(|row| self.candidate_ref_json(row))
                    .collect::<Vec<_>>(),
            },
            "rendered": {
                "payloadDigest": self.payload_digest,
                "renderCorrespondence": render_correspondence_json(&self.render_correspondence),
                "inputReferences": self
                    .input_references
                    .iter()
                    .map(input_reference_json)
                    .collect::<Vec<_>>(),
                "qualifications": self
                    .qualifications
                    .iter()
                    .map(|qualification| qualification_json(qualification, Some(qualification.input_ordinal)))
                    .collect::<Vec<_>>(),
            },
        })
    }

    /// The `candidate` arm of a receipt request: the payload D-final rendered.
    pub(crate) fn candidate_arm_json(&self) -> Value {
        json!({
            "arm": "candidate",
            "outcome": "rendered",
            "payload": self.payload,
            "payloadDigest": self.payload_digest,
            "renderCorrespondence": render_correspondence_json(&self.render_correspondence),
        })
    }
}

// ------------------------------------------------------- D-final outcome

/// D-final's return value as the receipt writes it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DfinalOutcome {
    Ok {
        payload_digest: String,
    },
    Err {
        code: String,
        reason: Option<String>,
    },
}

impl DfinalOutcome {
    pub(crate) fn from_result(result: &Result<NativePreparedRequest>) -> Self {
        match result {
            Ok(prepared) => Self::Ok {
                payload_digest: prepared.payload_digest.clone(),
            },
            Err(error) => {
                let message = error.to_string();
                match message.split_once(':') {
                    Some((code, reason)) => Self::Err {
                        code: code.trim().to_owned(),
                        reason: Some(reason.trim().to_owned()).filter(|reason| !reason.is_empty()),
                    },
                    None => Self::Err {
                        code: message.trim().to_owned(),
                        reason: None,
                    },
                }
            }
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        match self {
            Self::Ok { payload_digest } => {
                json!({ "outcome": "ok", "payloadDigest": payload_digest })
            }
            Self::Err { code, reason } => {
                let mut value = Map::new();
                value.insert("outcome".into(), json!("err"));
                value.insert("code".into(), json!(code));
                if let Some(reason) = reason {
                    value.insert("reason".into(), json!(reason));
                }
                Value::Object(value)
            }
        }
    }
}

/// One D-final call, its return value and the capture of the same request.
pub(crate) struct EvalRequestRecord {
    pub(crate) dfinal: DfinalOutcome,
    /// Present when (c-1) and (c-2) both ran for this call and matched.
    pub(crate) capture: Option<Box<CapturedRequest>>,
    /// Harness defects: a missing, foreign or duplicated observation. A
    /// request with a defect is not a product FAIL; the run is invalid.
    pub(crate) defects: Vec<String>,
    /// (c-1) ran but (c-2) did not: D-final rejected the request between the
    /// packing read and the render. No capture exists for such a request.
    pub(crate) candidate_set_without_render: bool,
}

impl EvalRequestRecord {
    /// The capture is a candidate for scoring only when D-final returned Ok
    /// and the Ok digest equals the captured candidate digest.
    pub(crate) fn scorable_capture(&self) -> Option<&CapturedRequest> {
        match (&self.dfinal, &self.capture) {
            (DfinalOutcome::Ok { payload_digest }, Some(capture))
                if self.defects.is_empty() && *payload_digest == capture.payload_digest =>
            {
                Some(capture)
            }
            _ => None,
        }
    }
}

/// Call D-final once and pair its return value with the capture of the same
/// request. The slots are emptied before the call, so an observation left by
/// an earlier call (or by a path other than D-final) cannot join this request;
/// whatever (c-1) left without a (c-2) is discarded and recorded.
pub(crate) fn run_dfinal_with_capture(
    call: impl FnOnce() -> Result<NativePreparedRequest>,
) -> (EvalRequestRecord, Option<NativePreparedRequest>) {
    db_eval::discard_candidate_set();
    drop(drain_observed());
    let result = call();
    let mut observed = drain_observed();
    let candidate_set_without_render = db_eval::take_candidate_set().is_some();
    let dfinal = DfinalOutcome::from_result(&result);
    let mut defects = Vec::new();
    let capture = match observed.len() {
        0 => None,
        1 => match observed.remove(0) {
            Observed::Captured(capture) => Some(capture),
            Observed::Defect(reason) => {
                defects.push(reason);
                None
            }
        },
        count => {
            defects.push(format!(
                "{count} (c-2) observations for one D-final call; the request is not attributable"
            ));
            None
        }
    };
    (
        EvalRequestRecord {
            dfinal,
            capture,
            defects,
            candidate_set_without_render,
        },
        result.ok(),
    )
}
