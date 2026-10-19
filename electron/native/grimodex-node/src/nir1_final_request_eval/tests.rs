//! DPH-3 tests: the capture pairing, the baseline arm, the parity vectors and
//! the receipt writer. They run a real D-final through the existing test
//! fixture (`seed_database` there is the D-final unit-test setup, not the
//! harness setup of DPH-4, which uses product writers only).

use std::sync::Arc;

use anyhow::{anyhow, Result};
use grimodex_core::narrative_nir1::PackingPurpose;
use grimodex_db::narrative_extraction::final_request_eval as db_eval;
use grimodex_db::narrative_extraction::{
    read_and_pack_native_a2_context, NativeNir1PackingRequest, NativeNir1RawContextItem,
};
use grimodex_db::state::active_workspace_snapshot;
use serde_json::{json, Value};

use super::baseline::{raw_exceeds_budget, select_context_items, SelectionItem};
use super::{
    run_baseline_arm, run_dfinal_with_capture, write_json_file, BaselineOutcome, CapturedRequest,
    DfinalOutcome, EvalRequestRecord,
};
use crate::nir1_prepared_request::tests::{
    prepare_local_chat_request, Fixture, NO_UNSUPPORTED_INPUTS, SCENE_ID,
};
use crate::nir1_prepared_request::{
    participant_sql_budget_for, prepare_local_chat_request_with_test_budget,
    prepare_local_chat_request_with_test_hook, NativePreparedRequest,
};

fn run(fixture: &Fixture) -> EvalRequestRecord {
    run_with(fixture, std::slice::from_ref(&fixture.revision_id))
}

fn run_with(fixture: &Fixture, revision_ids: &[String]) -> EvalRequestRecord {
    run_dfinal_with_capture(|| {
        prepare_local_chat_request(
            Arc::clone(&fixture.state),
            fixture.caller.clone(),
            SCENE_ID,
            &fixture.message_version_id,
            revision_ids,
            NO_UNSUPPORTED_INPUTS,
        )
    })
    .0
}

fn captured(record: &EvalRequestRecord) -> &CapturedRequest {
    record
        .capture
        .as_deref()
        .expect("D-final reached the render, so (c-2) captured the request")
}

fn foreign_single_revision_read(fixture: &Fixture) -> Result<()> {
    let workspace = active_workspace_snapshot(&fixture.state.ws)?;
    read_and_pack_native_a2_context(
        workspace.db().db(),
        NativeNir1PackingRequest {
            project_id: "default-project".into(),
            revision_id: fixture.revision_id.clone(),
            query_scene_id: SCENE_ID.into(),
            budget_tokens: 100_000,
            purpose: PackingPurpose::Writing,
            atomic_group: "single-revision-read".into(),
            raw_items: vec![NativeNir1RawContextItem {
                id: "project:scene:foreign".into(),
                text: "A foreign Raw body from the single-Revision reader.".into(),
                tokens: 20,
            }],
        },
    )?;
    Ok(())
}

// ------------------------------------------------------------------ capture

#[test]
fn capture_c1_c2_correlated_by_request() -> Result<()> {
    let fixture = Fixture::new()?;
    let first = run(&fixture);
    let second = run(&fixture);
    let (first_capture, second_capture) = (captured(&first), captured(&second));
    assert!(first.defects.is_empty() && second.defects.is_empty());
    assert!(!first.candidate_set_without_render);
    // The D-final return value sits in the same entry as the capture.
    let DfinalOutcome::Ok { payload_digest } = &first.dfinal else {
        panic!("D-final returned {:?}", first.dfinal);
    };
    assert_eq!(*payload_digest, first_capture.payload_digest);
    assert!(first.scorable_capture().is_some());
    // Each request has its own token, and (c-1) belongs to the same request.
    assert_ne!(first_capture.request_token, second_capture.request_token);
    assert_eq!(
        first_capture.request_token,
        format!("nir1-eval-request-{}", first_capture.candidate_set.sequence)
    );
    assert!(first_capture.candidate_set.sequence < second_capture.candidate_set.sequence);
    assert!(first_capture.candidate_set.pooled_source_path);
    // The slot was taken: nothing is left for the next request to inherit.
    assert!(db_eval::take_candidate_set().is_none());
    assert_eq!(
        first_capture.passed_revision_ids,
        vec![fixture.revision_id.clone()]
    );
    Ok(())
}

#[test]
fn capture_records_candidate_refs_via_product_function() -> Result<()> {
    let fixture = Fixture::new()?;
    let record = run(&fixture);
    let capture = captured(&record);
    let set = &capture.candidate_set;
    assert_eq!(set.candidate_refs.len(), 1);
    let candidate = &set.candidate_refs[0];
    assert_eq!(candidate.owner_id, fixture.revision_id);
    // The product function produced the rows: they equal the rendered rows of
    // the same Revision apart from the input ordinal and the D1 row, which the
    // render adds.
    let ordinal = capture
        .input_references
        .iter()
        .position(|reference| match &reference.target {
            grimodex_db::nir1_generation::InputTarget::AcceptedRevision { revision_id, .. } => {
                *revision_id == fixture.revision_id
            }
            _ => false,
        })
        .expect("the Revision was rendered");
    assert_eq!(candidate.input, capture.input_references[ordinal]);
    let rendered_rows = capture
        .qualifications
        .iter()
        .filter(|row| {
            row.input_ordinal == ordinal
                && row.kind != grimodex_db::nir1_generation::QualificationKind::D1
        })
        .map(|row| (row.kind, row.body.clone()))
        .collect::<Vec<_>>();
    let candidate_rows = candidate
        .qualifications
        .iter()
        .map(|row| (row.kind, row.body.clone()))
        .collect::<Vec<_>>();
    assert_eq!(candidate_rows, rendered_rows);
    // The JSON completes a rendered owner's ref with the rendered D1 row.
    let json = capture.capture_json();
    let refs = &json["candidateSet"]["candidateRefs"][0]["qualifications"];
    let kinds = refs
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["kind"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    for kind in [
        "source",
        "revision",
        "decision",
        "freshness",
        "index",
        "scope",
        "d1",
    ] {
        assert!(
            kinds.contains(&kind.to_owned()),
            "{kind} missing in {kinds:?}"
        );
    }
    // Candidate items: Raw first (no group), then the five parts of each group
    // of the Revision (the fixture Revision holds several Entity and Relation
    // groups).
    let items = json["candidateSet"]["items"].as_array().unwrap();
    assert_eq!(items[0]["kind"], "raw");
    assert!(items[0].get("atomicGroup").is_none());
    let parts = items[1..]
        .iter()
        .map(|item| item["atomicPart"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(!parts.is_empty() && parts.len() % 5 == 0, "{parts:?}");
    for group in parts.chunks(5) {
        assert_eq!(
            group,
            [
                "statement",
                "negation",
                "attribution",
                "evidence",
                "qualification"
            ]
        );
    }
    assert!(items[1..].iter().all(
        |item| item["kind"] == "accepted-ir" && item["ownerId"] == fixture.revision_id.as_str()
    ));
    Ok(())
}

#[test]
fn capture_excludes_non_dfinal_paths() -> Result<()> {
    let fixture = Fixture::new()?;
    // The single-Revision reader reaches (c-1) too. Its record is marked and
    // is not a D-final capture.
    foreign_single_revision_read(&fixture)?;
    let foreign = db_eval::take_candidate_set().expect("(c-1) saw the single-Revision read");
    assert!(!foreign.pooled_source_path);
    // A record left behind by such a path cannot join the next request: the
    // harness entry empties the slot before the call.
    foreign_single_revision_read(&fixture)?;
    let record = run(&fixture);
    assert!(record.defects.is_empty(), "{:?}", record.defects);
    let capture = captured(&record);
    assert!(capture.candidate_set.pooled_source_path);
    assert!(capture.candidate_set.sequence > foreign.sequence);
    assert_eq!(
        capture.candidate_set.items[0].item_id,
        "project:scene:nir1-prepared-scene"
    );
    // A foreign (c-1) record planted between the packing read and the render
    // of a D-final request is rejected by (c-2), never attributed.
    let revision_ids = [fixture.revision_id.clone()];
    let (planted, prepared) = run_dfinal_with_capture(|| {
        let sql_budget = participant_sql_budget_for(Arc::clone(&fixture.message_version_id.stop));
        prepare_local_chat_request_with_test_budget(
            Arc::clone(&fixture.state),
            fixture.caller.clone(),
            SCENE_ID,
            &fixture.message_version_id,
            &revision_ids,
            sql_budget,
            || Ok(()),
            || foreign_single_revision_read(&fixture),
            || Ok(()),
        )
    });
    assert!(
        prepared.is_some(),
        "D-final itself is unchanged by the capture"
    );
    assert!(planted.capture.is_none());
    assert_eq!(planted.defects.len(), 1);
    assert!(
        planted.defects[0].contains("other than D-final"),
        "{:?}",
        planted.defects
    );
    assert!(planted.scorable_capture().is_none());
    Ok(())
}

#[test]
fn capture_c1_without_c2_is_dropped_and_not_attributed() -> Result<()> {
    let fixture = Fixture::new()?;
    let revision_ids = [fixture.revision_id.clone()];
    let (stopped, prepared) = run_dfinal_with_capture(|| {
        let sql_budget = participant_sql_budget_for(Arc::clone(&fixture.message_version_id.stop));
        prepare_local_chat_request_with_test_budget(
            Arc::clone(&fixture.state),
            fixture.caller.clone(),
            SCENE_ID,
            &fixture.message_version_id,
            &revision_ids,
            sql_budget,
            || Ok(()),
            || Err(anyhow!("NIR1_EVAL_TEST_STOP_BEFORE_RENDER")),
            || Ok(()),
        )
    });
    assert!(prepared.is_none());
    assert!(stopped.capture.is_none());
    assert!(stopped.candidate_set_without_render);
    assert!(stopped.defects.is_empty());
    assert_eq!(
        stopped.dfinal,
        DfinalOutcome::Err {
            code: "NIR1_EVAL_TEST_STOP_BEFORE_RENDER".into(),
            reason: None
        }
    );
    // The leftover is gone and the next request is attributed to itself.
    assert!(db_eval::take_candidate_set().is_none());
    let next = run(&fixture);
    assert!(next.defects.is_empty() && !next.candidate_set_without_render);
    assert!(next.scorable_capture().is_some());
    Ok(())
}

#[test]
fn capture_survives_a_dfinal_err_after_the_render() -> Result<()> {
    let fixture = Fixture::new()?;
    let revision_ids = [fixture.revision_id.clone()];
    let (record, prepared) = run_dfinal_with_capture(|| {
        prepare_local_chat_request_with_test_hook(
            Arc::clone(&fixture.state),
            fixture.caller.clone(),
            SCENE_ID,
            &fixture.message_version_id,
            &revision_ids,
            || Err(anyhow!("NIR1_PREPARED_TEST_REJECT_AFTER_RENDER:late")),
        )
    });
    assert!(prepared.is_none());
    // (c-2) ran before the later rejection, so a capture exists, but D-final
    // did not return Ok: it is not scorable and the baseline is not called.
    let capture = captured(&record);
    assert_eq!(
        record.dfinal,
        DfinalOutcome::Err {
            code: "NIR1_PREPARED_TEST_REJECT_AFTER_RENDER".into(),
            reason: Some("late".into())
        }
    );
    assert!(record.scorable_capture().is_none());
    let refused = run_baseline_arm(capture, &record.dfinal);
    assert_eq!(refused.err().unwrap().reason, "dfinal-did-not-return-ok");
    Ok(())
}

#[test]
fn capture_is_absent_when_dfinal_rejects_before_the_candidate_set() -> Result<()> {
    let fixture = Fixture::new()?;
    let record = run_with(&fixture, &["nir1-eval-no-such-revision".to_owned()]);
    assert!(record.capture.is_none());
    assert!(!record.candidate_set_without_render);
    assert!(record.defects.is_empty());
    let DfinalOutcome::Err { code, reason } = &record.dfinal else {
        panic!("D-final accepted an unknown Revision");
    };
    assert_eq!(code, "NIR1_NATIVE_A2_UNAVAILABLE");
    assert!(reason.is_some());
    Ok(())
}

#[test]
fn dfinal_outcome_splits_code_and_reason_at_the_first_colon() {
    let outcome = |message: &str| {
        let result: Result<NativePreparedRequest> = Err(anyhow!("{message}"));
        DfinalOutcome::from_result(&result)
    };
    assert_eq!(
        outcome("NIR1_NATIVE_A2_UNAVAILABLE:revision-not-human-approved"),
        DfinalOutcome::Err {
            code: "NIR1_NATIVE_A2_UNAVAILABLE".into(),
            reason: Some("revision-not-human-approved".into())
        }
    );
    assert_eq!(
        outcome("NIR1_PREPARED_PAYLOAD_SIZE_LIMIT"),
        DfinalOutcome::Err {
            code: "NIR1_PREPARED_PAYLOAD_SIZE_LIMIT".into(),
            reason: None
        }
    );
    assert_eq!(
        outcome("NIR1_NATIVE_PREPARED_QUALIFICATION_INCOMPLETE: input 2 lacks scope"),
        DfinalOutcome::Err {
            code: "NIR1_NATIVE_PREPARED_QUALIFICATION_INCOMPLETE".into(),
            reason: Some("input 2 lacks scope".into())
        }
    );
}

#[test]
fn capture_json_has_the_receipt_contract_keys() -> Result<()> {
    let fixture = Fixture::new()?;
    let record = run(&fixture);
    let capture = captured(&record);
    let json = capture.capture_json();
    let mut keys = json
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        [
            "candidateSet",
            "capturedTurnId",
            "contextBudgetTokens",
            "estimatorVersion",
            "measure",
            "passedRevisionIds",
            "rendered",
            "requestToken",
            "route",
            "snapshotIdentity",
            "template",
            "userMessage",
        ]
    );
    assert_eq!(json["measure"], "item-estimate-sum");
    assert_eq!(json["template"]["version"], "nir1-local-chat-system-ja-v1");
    assert_eq!(
        json["userMessage"]["digestSha256"].as_str().unwrap().len(),
        64
    );
    assert!(json["rendered"]["payloadDigest"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    let candidate = capture.candidate_arm_json();
    assert_eq!(candidate["arm"], "candidate");
    assert_eq!(candidate["payload"], capture.payload.as_str());
    assert_eq!(record.dfinal.to_json()["outcome"], "ok");
    Ok(())
}

// ----------------------------------------------------------------- baseline

fn raw_tokens(capture: &CapturedRequest) -> usize {
    capture
        .candidate_set
        .items
        .iter()
        .filter(|row| row.kind == "raw")
        .map(|row| row.tokens)
        .sum()
}

#[test]
fn baseline_goes_through_render_entry() -> Result<()> {
    let fixture = Fixture::new()?;
    let record = run(&fixture);
    let capture = captured(&record);
    // With the whole candidate set within the budget the baseline keeps every
    // item. The renderer input is built by the product function and rendered by
    // the same entry as the candidate, so the payload is byte-identical.
    let result = run_baseline_arm(capture, &record.dfinal).expect("D-final returned Ok");
    let BaselineOutcome::Rendered {
        payload,
        payload_digest,
        ..
    } = &result.outcome
    else {
        panic!("the baseline did not render");
    };
    assert_eq!(*payload, capture.payload);
    assert_eq!(*payload_digest, capture.payload_digest);
    let selection = result.selection.as_ref().unwrap();
    assert_eq!(
        selection.selected_keys.len(),
        capture.candidate_set.items.len()
    );
    // A smaller budget changes the selection item by item and the payload
    // follows the kept items: the lowest-ranked (earliest) parts go first.
    let mut shrunk = capture.clone();
    let ir_rows = capture
        .candidate_set
        .items
        .iter()
        .filter(|row| row.kind == "accepted-ir")
        .collect::<Vec<_>>();
    assert!(ir_rows.len() >= 5);
    // Room for Raw and the last two accepted IR items only.
    let last_two = &ir_rows[ir_rows.len() - 2..];
    shrunk.context_budget_tokens = raw_tokens(capture) + last_two[0].tokens + last_two[1].tokens;
    let result = run_baseline_arm(&shrunk, &record.dfinal).expect("Ok");
    let selection = result.selection.as_ref().unwrap();
    let kept = ir_rows
        .iter()
        .filter(|row| selection.selected_keys.contains(&row.item_id))
        .map(|row| row.item_id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        kept,
        [last_two[0].item_id.as_str(), last_two[1].item_id.as_str()]
    );
    let BaselineOutcome::Rendered { payload, .. } = &result.outcome else {
        panic!("a Raw plus two kept parts is renderable");
    };
    let payload: Value = serde_json::from_str(payload)?;
    let system = payload["messages"][0]["content"].as_str().unwrap();
    for row in &capture.candidate_set.items {
        // The text of an IR part is in the system message only when kept.
        if row.kind == "accepted-ir" {
            let kept = selection.selected_keys.contains(&row.item_id);
            assert_eq!(system.contains(&row.text), kept, "{}", row.item_id);
        }
    }
    let arm = result.arm_json(&shrunk, 0);
    assert_eq!(arm["outcome"], "rendered");
    assert_eq!(arm["persistedRows"], 0);
    assert!(arm["inputs"]["candidateSetDigest"].is_string());
    assert_eq!(arm["counters"]["qualifiedEvidence"], 0);
    Ok(())
}

#[test]
fn baseline_unrenderable_selection_is_typed_failure() -> Result<()> {
    let fixture = Fixture::new()?;
    let record = run(&fixture);
    let capture = captured(&record);
    // Budget = Raw only: every accepted IR item is removed, Raw alone remains.
    let mut raw_only = capture.clone();
    raw_only.context_budget_tokens = raw_tokens(capture);
    let result = run_baseline_arm(&raw_only, &record.dfinal).expect("Ok");
    assert_eq!(result.selection.as_ref().unwrap().selected_keys.len(), 1);
    let BaselineOutcome::Unrenderable { reason } = &result.outcome else {
        panic!("a Raw-only selection must not be rendered");
    };
    assert_eq!(reason, "accepted-ir-missing");
    let arm = result.arm_json(&raw_only, 0);
    assert_eq!(arm["outcome"], "unrenderable");
    assert!(arm.get("payload").is_none() && arm.get("payloadDigest").is_none());
    // Raw alone over the budget is the typed "input reduction required".
    let mut tiny = capture.clone();
    tiny.context_budget_tokens = raw_tokens(capture) - 1;
    let result = run_baseline_arm(&tiny, &record.dfinal).expect("Ok");
    assert!(result.selection.is_none());
    assert!(matches!(
        result.outcome,
        BaselineOutcome::InputReductionRequired { .. }
    ));
    assert_eq!(
        result.arm_json(&tiny, 0)["outcome"],
        "input-reduction-required"
    );
    // A rendered request over the route's window is the typed window result.
    let mut narrow = capture.clone();
    narrow.route.context_window_tokens = 64;
    let result = run_baseline_arm(&narrow, &record.dfinal).expect("Ok");
    let BaselineOutcome::WindowExceeded { reason } = &result.outcome else {
        panic!("the narrowed window must be exceeded");
    };
    assert!(reason.starts_with("NIR1_PREPARED_CONTEXT_WINDOW_EXCEEDED"));
    assert_eq!(result.arm_json(&narrow, 0)["outcome"], "window-exceeded");
    Ok(())
}

#[test]
fn baseline_payload_not_persisted() -> Result<()> {
    let fixture = Fixture::new()?;
    let record = run(&fixture);
    let capture = captured(&record);
    let before = fixture.generation_storage_counts()?;
    let mut shrunk = capture.clone();
    shrunk.context_budget_tokens = raw_tokens(capture) + 40;
    let result = run_baseline_arm(&shrunk, &record.dfinal).expect("Ok");
    assert!(result.selection.is_some());
    // chat_messages, message versions, attempts, input refs, qualification refs.
    assert_eq!(fixture.generation_storage_counts()?, before);
    assert_eq!(fixture.attempt_count()?, 0);
    Ok(())
}

#[test]
fn baseline_is_refused_for_a_request_it_must_not_run_on() -> Result<()> {
    let fixture = Fixture::new()?;
    let record = run(&fixture);
    let capture = captured(&record);
    let mismatch = DfinalOutcome::Ok {
        payload_digest: "sha256:".to_owned() + &"0".repeat(64),
    };
    assert_eq!(
        run_baseline_arm(capture, &mismatch).err().unwrap().reason,
        "dfinal-digest-differs-from-capture"
    );
    let mut foreign = capture.clone();
    foreign.candidate_set = {
        foreign_single_revision_read(&fixture)?;
        db_eval::take_candidate_set().unwrap()
    };
    assert_eq!(
        run_baseline_arm(&foreign, &record.dfinal)
            .err()
            .unwrap()
            .reason,
        "capture-is-not-a-dfinal-capture"
    );
    Ok(())
}

const PARITY_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../evals/nir1-packing/final-request-baseline-parity.v1.json"
));

#[test]
fn baseline_selection_matches_ts_select_context_items_vectors() -> Result<()> {
    let vectors: Value = serde_json::from_str(PARITY_VECTORS)?;
    // The kind table is the TS table, not a second definition.
    assert_eq!(vectors["kindTable"]["raw"]["priority"], 100);
    assert_eq!(
        vectors["kindTable"]["accepted-ir"]["authority"],
        "canonical"
    );
    let cases = vectors["cases"].as_array().unwrap();
    assert!(cases.len() >= 12);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let items = case["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| SelectionItem {
                key: item["key"].as_str().unwrap().to_owned(),
                kind: item["kind"].as_str().unwrap().to_owned(),
                tokens: item["tokens"].as_u64().unwrap() as usize,
            })
            .collect::<Vec<_>>();
        let budget = case["budgetTokens"].as_u64().unwrap() as usize;
        let expected = &case["expected"];
        let selection = select_context_items(&items, budget)?;
        let selected_keys = expected["selectedKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            selection.selected_keys, selected_keys,
            "{name}: selectedKeys"
        );
        let decisions = expected["decisions"].as_array().unwrap();
        assert_eq!(selection.decisions.len(), decisions.len(), "{name}");
        for (actual, expected) in selection.decisions.iter().zip(decisions) {
            assert_eq!(actual.key, expected["key"].as_str().unwrap(), "{name}");
            let status = if actual.selected {
                "selected"
            } else {
                "trimmed"
            };
            let reason = if actual.selected {
                "within-budget"
            } else {
                "budget-priority"
            };
            assert_eq!(
                status,
                expected["status"].as_str().unwrap(),
                "{name}: {}",
                actual.key
            );
            assert_eq!(reason, expected["reason"].as_str().unwrap(), "{name}");
            assert_eq!(
                actual.tokens_before as u64, expected["tokensBefore"],
                "{name}"
            );
            assert_eq!(
                actual.tokens_after as u64, expected["tokensAfter"],
                "{name}"
            );
        }
        let usage = &expected["usage"];
        assert_eq!(
            selection.candidate_tokens as u64, usage["candidateTokens"],
            "{name}"
        );
        assert_eq!(
            selection.selected_tokens as u64, usage["selectedTokens"],
            "{name}"
        );
        assert_eq!(
            selection.trimmed_tokens as u64, usage["trimmedTokens"],
            "{name}"
        );
        assert_eq!(
            selection.budget_tokens as u64, usage["budgetTokens"],
            "{name}"
        );
        assert_eq!(
            raw_exceeds_budget(&items, budget),
            expected["inputReductionRequired"].as_bool().unwrap(),
            "{name}: inputReductionRequired"
        );
    }
    Ok(())
}

// ----------------------------------------------------------------- receipt

#[test]
fn receipt_writer_writes_only_under_artifacts_and_never_overwrites() -> Result<()> {
    let root = std::env::temp_dir().join(format!("nir1-eval-receipt-{}", uuid::Uuid::new_v4()));
    let artifacts = root.join(".artifacts").join("run-1");
    let value = json!({ "schemaVersion": "nir1-final-request-receipt/1" });
    let path = write_json_file(&artifacts, "receipt.json", &value)?;
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&path)?)?,
        value
    );
    // An existing file is not overwritten.
    assert!(write_json_file(&artifacts, "receipt.json", &value).is_err());
    // Outside `.artifacts`, with a path in the name, or with a parent component.
    assert!(write_json_file(&root.join("elsewhere"), "receipt.json", &value).is_err());
    for name in [
        "../receipt.json",
        "a/b.json",
        ".hidden.json",
        "receipt.txt",
        ".json",
    ] {
        assert!(write_json_file(&artifacts, name, &value).is_err(), "{name}");
    }
    assert!(write_json_file(&artifacts.join("..").join("x"), "r.json", &value).is_err());
    std::fs::remove_dir_all(&root)?;
    Ok(())
}

// ------------------------------------------------------ build capabilities

#[tokio::test]
async fn build_capabilities_report_the_eval_feature_under_the_feature() -> Result<()> {
    let root = std::env::temp_dir().join(format!("nir1-eval-caps-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root)?;
    let backend = crate::Backend::new(root.to_string_lossy().into_owned(), None, None)?;
    let capabilities: Value =
        serde_json::from_str(&backend.get_native_build_capabilities().await?)?;
    assert_eq!(capabilities["nir1FinalRequestEval"], true);
    std::fs::remove_dir_all(&root)?;
    Ok(())
}

// -------------------------------------------- K2/4 defense 2 at (c-1), (c-2)

/// DI-1a A-13: a worker that answers with text and a Scene association leaves
/// no trace in the candidate set (c-1) or the capture (c-2) of a request that
/// uses its Graph. The Graph group's text comes from the snapshot's Revision.
#[test]
fn a13_the_graph_request_capture_carries_no_worker_text_or_scene_association() {
    use crate::nir1_graph_dfinal::tests::{assert_free_of_worker_text, Rig};

    let rig = Rig::new();
    rig.open();
    let (record, _) = run_dfinal_with_capture(|| rig.request().map(|s| s.into_parts().0));
    assert!(record.defects.is_empty(), "{:?}", record.defects);
    let capture = captured(&record);
    let set = &capture.candidate_set;
    assert!(
        set.items.iter().any(|item| item.kind == "graph-evidence"),
        "the candidate set holds a Graph group, so the scan means something"
    );
    assert_free_of_worker_text("the candidate items", &format!("{:?}", set.items));
    assert_free_of_worker_text("the candidate refs", &format!("{:?}", set.candidate_refs));
    assert_free_of_worker_text("the captured payload", &capture.payload);
    assert_free_of_worker_text(
        "the captured input references",
        &format!("{:?}", capture.input_references),
    );
    assert_free_of_worker_text(
        "the captured qualifications",
        &format!("{:?}", capture.qualifications),
    );
    assert_free_of_worker_text(
        "the captured render correspondence",
        &format!("{:?}", capture.render_correspondence),
    );
}
