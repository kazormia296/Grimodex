//! DPH-4 harness tests: the freeze gate, the case workspaces, the setup order,
//! the requests and the receipts. They build real workspaces with product
//! writers and call the real D-final; nothing is sent anywhere.
//!
//! The mechanics tests run on `mechanics-fixture.json`, a synthetic fixture with
//! its own logical IDs, texts and canaries. They never read the frozen
//! fixture (`FIXTURE_PATH`, version 2; version 1 is superseded): that fixture's
//! materials reach Native only through `evidence_run`, behind the freeze gate
//! (draft K6/2 観測前の固定). `mechanics_fixture_shares_no_material_with_the_
//! frozen_fixture` pins the separation.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use anyhow::{Context, Result};
use grimodex_db::narrative_extraction::final_request_eval::sha256_hex;
use serde_json::{json, Value};

use super::fixture::{validate_variant_setup, Fixture};
use super::freeze::{
    check_freeze, EVIDENCE_FIXTURE_VERSION, FIXTURE_PATH, FREEZE_PATH, REVIEW_PATH,
    SUPERSEDED_FIXTURE_PATH, SUPERSEDED_FREEZE_PATH,
};
use super::run::{run_variant, VariantOutcome};
use super::workspace::CaseWorkspace;
use super::{evidence_run, run_all_variants, EvidenceOutcome};

/// The writers the setup may invoke (the draft's list of product writers; the
/// scorer holds the same list in receipt.mjs `PRODUCT_WRITERS` and rejects
/// anything else).
const ALLOWED_WRITERS: [&str; 14] = [
    "tree_node_create",
    "narrative_scene_scope_update",
    "narrative_scene_scope_registry_update",
    "codex_create",
    "codex_update",
    "nir1_entity_relation_revision_prepare",
    "narrative_extraction_append_human_decision",
    "write_ai_settings",
    "db_execute:createSession",
    "activate_first_restricted_publication",
    // Writers that only the maintenance owner runs, listed as row-changing
    // writers in the extensions, never as setup writers.
    "narrative_maintenance_owner",
    "tree_node_patch",
    "save_scene_body_bundle",
    "project_create",
];

/// The synthetic fixture the mechanics tests run on.
const MECHANICS_FIXTURE: &str = include_str!("mechanics-fixture.json");

fn fixture_text() -> Result<(Fixture, Value, String)> {
    Ok((
        Fixture::parse(MECHANICS_FIXTURE)?,
        serde_json::from_str(MECHANICS_FIXTURE)?,
        MECHANICS_FIXTURE.to_owned(),
    ))
}

/// One run of every variant, shared by the tests that read its outcome.
fn all_outcomes() -> &'static Vec<VariantOutcome> {
    static OUTCOMES: OnceLock<std::result::Result<Vec<VariantOutcome>, String>> = OnceLock::new();
    match OUTCOMES.get_or_init(|| {
        let (fixture, _, _) = fixture_text().map_err(|error| format!("{error:#}"))?;
        run_all_variants(&fixture).map_err(|error| format!("{error:#}"))
    }) {
        Ok(outcomes) => outcomes,
        Err(error) => panic!("the harness run failed: {error}"),
    }
}

fn outcome_of<'a>(outcomes: &'a [VariantOutcome], variant_id: &str) -> &'a VariantOutcome {
    outcomes
        .iter()
        .find(|outcome| outcome.variant_id == variant_id)
        .unwrap_or_else(|| panic!("no outcome for {variant_id}"))
}

fn variant_kind(raw: &Value, variant_id: &str) -> String {
    for case in raw["cases"].as_array().into_iter().flatten() {
        for variant in case["variants"].as_array().into_iter().flatten() {
            if variant["variantId"] == variant_id {
                return variant["kind"].as_str().unwrap_or_default().to_owned();
            }
        }
    }
    panic!("no variant {variant_id}");
}

fn events(outcome: &VariantOutcome) -> Vec<Value> {
    outcome.setup_case["events"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn seq_of(event: &Value) -> u64 {
    event["seq"].as_u64().unwrap_or_default()
}

fn kind_of(event: &Value) -> &str {
    event["kind"].as_str().unwrap_or_default()
}

// ------------------------------------------------------------- requests

#[test]
fn final_request_positive_variants_return_ok_matching_capture() -> Result<()> {
    let (_, raw, _) = fixture_text()?;
    let outcomes = all_outcomes();
    let mut positive_requests = 0;
    for outcome in outcomes {
        let reject_variant = variant_kind(&raw, &outcome.variant_id) == "reject";
        for (index, request) in outcome.requests.iter().enumerate() {
            let is_final = index + 1 == outcome.requests.len();
            if reject_variant && is_final {
                continue;
            }
            positive_requests += 1;
            let label = format!("{} request {index}", outcome.variant_id);
            assert_eq!(request["requestKind"], "positive", "{label}");
            assert_eq!(
                request["dfinal"]["outcome"], "ok",
                "{label}: {}",
                request["dfinal"]
            );
            let digest = &request["dfinal"]["payloadDigest"];
            assert_eq!(
                *digest, request["capture"]["rendered"]["payloadDigest"],
                "{label}"
            );
            assert_eq!(*digest, request["candidate"]["payloadDigest"], "{label}");
            assert_eq!(request["candidate"]["outcome"], "rendered", "{label}");
            assert!(
                request["baseline"].is_null(),
                "{label}: only the P-12 diagnostic has a baseline arm"
            );
            // The Revision IDs handed to D-final are the capture's.
            assert_eq!(
                request["passedRevisionIds"], request["capture"]["passedRevisionIds"],
                "{label}"
            );
        }
    }
    // M-A: 1 positive request. M-B: 2 requests in each of 3 positive variants
    // plus the stage-1 request of each of 3 reject variants.
    assert_eq!(positive_requests, 10);
    Ok(())
}

#[test]
fn final_request_reject_variants_fail_closed_with_expected_reason() -> Result<()> {
    let (_, raw, _) = fixture_text()?;
    let outcomes = all_outcomes();
    let mut rejects = 0;
    for case in raw["cases"].as_array().context("cases")? {
        for variant in case["variants"].as_array().context("variants")? {
            if variant["kind"] != "reject" {
                continue;
            }
            rejects += 1;
            let variant_id = variant["variantId"].as_str().context("variantId")?;
            let outcome = outcome_of(outcomes, variant_id);
            let request = outcome
                .requests
                .last()
                .context("a reject variant has a request")?;
            let expected = &variant["requests"]
                .as_array()
                .and_then(|requests| requests.last())
                .context("last request")?["expected"];
            assert_eq!(request["requestKind"], "reject", "{variant_id}");
            assert_eq!(request["dfinal"]["outcome"], "err", "{variant_id}");
            assert_eq!(request["dfinal"]["code"], expected["code"], "{variant_id}");
            assert_eq!(
                request["dfinal"]["reason"], expected["reason"],
                "{variant_id}"
            );
            // Fail closed: no payload, no render correspondence, no capture,
            // no attempt row.
            assert!(request["capture"].is_null(), "{variant_id}");
            assert!(request["candidate"].is_null(), "{variant_id}");
            assert_eq!(request["attemptRowsAdded"], 0, "{variant_id}");
        }
    }
    // M-A: 3 reject variants. M-B: 3 reject variants.
    assert_eq!(rejects, 6);
    Ok(())
}

#[test]
fn request_phase_writes_are_the_capture_and_dfinal_rows_only() {
    // Whatever a request changes is changed by the chat capture and D-final,
    // in the generation storage and the chat message tables, and nowhere else.
    for outcome in all_outcomes() {
        assert!(
            !outcome.request_phase_changes.is_empty(),
            "{}",
            outcome.variant_id
        );
        for (table, action) in &outcome.request_phase_changes {
            assert!(
                table.starts_with("nir1_generation_")
                    || table.starts_with("nir1_chat_input_")
                    || table.starts_with("chat_messages"),
                "{}: request phase {action} {table}",
                outcome.variant_id
            );
        }
    }
}

#[test]
fn attempt_rows_are_added_by_a_rendered_request_only() {
    for outcome in all_outcomes() {
        for request in &outcome.requests {
            let rows = request["attemptRowsAdded"].as_i64().unwrap_or(-1);
            match request["dfinal"]["outcome"].as_str() {
                Some("err") => assert_eq!(rows, 0, "{}", outcome.variant_id),
                _ => assert!(rows >= 0, "{}", outcome.variant_id),
            }
        }
    }
}

// ---------------------------------------------------------------- setup

#[test]
fn setup_receipt_records_write_order_and_eligibility() {
    for outcome in all_outcomes() {
        let label = &outcome.variant_id;
        let events = events(outcome);
        let seqs: Vec<u64> = events.iter().map(seq_of).collect();
        assert!(
            seqs.windows(2).all(|pair| pair[0] < pair[1]),
            "{label}: seq must increase"
        );

        let first_prepare = events
            .iter()
            .find(|event| kind_of(event) == "prepare")
            .map(seq_of)
            .unwrap_or_else(|| panic!("{label}: no prepare event"));
        // The tree, Scope and Codex writes precede the first prepare.
        let base_kinds = ["tree", "scope", "codex"];
        let last_base = events
            .iter()
            .filter(|event| base_kinds.contains(&kind_of(event)))
            .map(seq_of)
            .max()
            .unwrap_or_default();
        assert!(
            last_base < first_prepare,
            "{label}: a tree/Scope/Codex write follows the first prepare"
        );
        // In stage 1 nothing but chat sessions, restricted and capture follows the last approve.
        let last_approve = events
            .iter()
            .filter(|event| kind_of(event) == "approve" && event["stage"] == json!(1))
            .map(seq_of)
            .max()
            .unwrap_or_default();
        for event in events
            .iter()
            .filter(|event| event["stage"] == json!(1) && seq_of(event) > last_approve)
        {
            assert!(
                ["chat-session", "restricted", "capture"].contains(&kind_of(event)),
                "{label}: {} follows the last approval",
                kind_of(event)
            );
        }
        // Every stage with a request has setup-end and request-pre rows that
        // agree on the Scope authority revision and are restricted.
        let verifications = outcome.setup_case["verifications"]
            .as_array()
            .expect("verifications");
        for request in &outcome.requests {
            let stage = request["stage"].clone();
            let end = verifications
                .iter()
                .find(|row| row["stage"] == stage && row["point"] == "setup-end")
                .unwrap_or_else(|| panic!("{label}: no setup-end for stage {stage}"));
            let pre = verifications
                .iter()
                .find(|row| row["stage"] == stage && row["point"] == "request-pre")
                .unwrap_or_else(|| panic!("{label}: no request-pre for stage {stage}"));
            assert_eq!(
                end["scopeAuthorityRevision"], pre["scopeAuthorityRevision"],
                "{label}"
            );
            assert_ne!(pre["scopeAuthorityRevision"], "unavailable", "{label}");
            assert_eq!(
                pre["d2a"],
                json!({"restricted": true, "inFlightStopped": true}),
                "{label}"
            );
            // Every Revision of the request is eligible and fresh, except the
            // reject variant's negative at the reject request.
            let passed = request["passedRevisionIds"].as_array().expect("passed");
            let eligible: Vec<&Value> = pre["revisions"]
                .as_array()
                .expect("revisions")
                .iter()
                .filter(|row| {
                    row["a2"] == "eligible"
                        && row["a3"] == "eligible"
                        && row["freshness"] == "fresh"
                })
                .collect();
            let expected_ineligible = usize::from(request["requestKind"] == "reject");
            assert_eq!(
                eligible.len() + expected_ineligible,
                passed.len(),
                "{label} stage {stage}"
            );
        }
        assert_eq!(outcome.setup_case["directDmlObserved"], false, "{label}");
        assert_eq!(outcome.setup_case["valid"], true, "{label}");
    }
}

#[test]
fn setup_end_is_taken_before_chat_sessions_and_restricted_activation() {
    // The first stage's setup-end row is read right after its last prepare or
    // approve, before the chat sessions and the restricted activation, so the
    // Scope authority revision comparison with request-pre spans them. A later
    // stage's setup-end is read after the profile is restricted.
    for outcome in all_outcomes() {
        let label = &outcome.variant_id;
        let verifications = outcome.setup_case["verifications"]
            .as_array()
            .expect("verifications");
        let first_stage = outcome.requests[0]["stage"].clone();
        for request in &outcome.requests {
            let stage = request["stage"].clone();
            let end = verifications
                .iter()
                .find(|row| row["stage"] == stage && row["point"] == "setup-end")
                .unwrap_or_else(|| panic!("{label}: no setup-end for stage {stage}"));
            if stage == first_stage {
                assert_eq!(
                    end["d2a"]["restricted"],
                    json!(false),
                    "{label}: the first stage's setup-end must precede the restricted activation"
                );
            } else {
                assert_eq!(end["d2a"]["restricted"], json!(true), "{label}");
            }
        }
        // One D-final result per request, kept for these tests.
        assert_eq!(outcome.dfinal.len(), outcome.requests.len(), "{label}");
    }
}

#[test]
fn project_create_is_named_as_a_product_writer_in_the_setup_receipt() {
    // The case's project is created by the product's `project_create`; it is
    // a tree event and in writersUsed (the scorer's list names it), not hidden
    // in an extension.
    for outcome in all_outcomes() {
        let label = &outcome.variant_id;
        let created: Vec<Value> = events(outcome)
            .into_iter()
            .filter(|event| event["writer"] == "project_create")
            .collect();
        assert_eq!(created.len(), 1, "{label}");
        assert_eq!(kind_of(&created[0]), "tree", "{label}");
        let id_map = outcome.setup_case["idMap"].as_array().expect("idMap");
        assert!(
            id_map
                .iter()
                .any(|row| row["logicalId"] == created[0]["logicalId"]
                    && row["runtimeId"] == created[0]["runtimeId"]),
            "{label}: the project event names the id map's project"
        );
        assert!(
            outcome.setup_case["writersUsed"]
                .as_array()
                .expect("writersUsed")
                .iter()
                .any(|writer| writer == "project_create"),
            "{label}"
        );
        assert!(
            outcome.setup_case["extensions"]
                .get("provisioningWriters")
                .is_none(),
            "{label}"
        );
        // The project is created before any other base write.
        let first_other = events(outcome)
            .iter()
            .find(|event| {
                event["writer"] != "write_ai_settings" && event["writer"] != "project_create"
            })
            .map(seq_of)
            .expect("another event");
        assert!(seq_of(&created[0]) < first_other, "{label}");
    }
}

#[test]
fn scope_runtime_value_is_the_revisions_own_scope_authority_revision() {
    // `revisionToken` stands for the Scope authority revision that the
    // Revision's entries carry (`scope.authorityRevision`), which since X1-3 is
    // the anchor Scene's projection token, not the project-level revision the
    // setup compares between setup-end and request-pre.
    let mut checked = 0;
    for outcome in all_outcomes() {
        let label = &outcome.variant_id;
        let verifications = outcome.setup_case["verifications"]
            .as_array()
            .expect("verifications");
        for value in outcome.setup_case["runtimeValues"]
            .as_array()
            .expect("runtimeValues")
            .iter()
            .filter(|value| value["kind"] == "revisionToken")
        {
            let token = value["value"].as_str().expect("token");
            let project_level = verifications
                .iter()
                .find(|row| row["stage"] == value["stage"] && row["point"] == "request-pre")
                .map(|row| row["scopeAuthorityRevision"].clone())
                .expect("request-pre");
            assert_ne!(json!(token), project_level, "{label}");
            let request = outcome
                .requests
                .iter()
                .find(|request| request["stage"] == value["stage"])
                .expect("request");
            if request["dfinal"]["outcome"] == "ok" {
                let payload = request["candidate"]["payload"].to_string();
                assert!(
                    payload.contains(token),
                    "{label} stage {}: the rendered payload does not carry the Scope authority revision {token}",
                    value["stage"]
                );
                checked += 1;
            }
        }
    }
    assert!(checked >= 10, "{checked}");
}

#[test]
fn restricted_established_after_setup_writes() {
    for outcome in all_outcomes() {
        let label = &outcome.variant_id;
        let events = events(outcome);
        let restricted = events
            .iter()
            .find(|event| kind_of(event) == "restricted")
            .map(seq_of)
            .unwrap_or_else(|| panic!("{label}: no restricted event"));
        let first_capture = events
            .iter()
            .find(|event| kind_of(event) == "capture")
            .map(seq_of)
            .unwrap_or_else(|| panic!("{label}: no capture event"));
        assert!(
            restricted < first_capture,
            "{label}: restricted must precede the first capture"
        );
        // Everything written for stage 1 precedes restricted.
        for event in events.iter().filter(|event| {
            event["stage"] == json!(1) && !["restricted", "capture"].contains(&kind_of(event))
        }) {
            assert!(
                seq_of(event) < restricted,
                "{label}: {} is after restricted",
                kind_of(event)
            );
        }
        // Every chat session is created before restricted.
        let sessions: Vec<&Value> = events
            .iter()
            .filter(|event| kind_of(event) == "chat-session")
            .collect();
        assert!(!sessions.is_empty(), "{label}");
        assert!(
            sessions.iter().all(|event| seq_of(event) < restricted),
            "{label}"
        );
        assert_eq!(
            outcome.setup_case["chatSession"],
            json!({
                "writer": "db_execute:createSession",
                "statementMatchesRenderer": true,
                "createdBeforeRestricted": true,
            }),
            "{label}"
        );
    }
}

#[test]
fn history_slot_is_not_applicable_and_recorded() {
    for outcome in all_outcomes() {
        assert_eq!(
            outcome.setup_case["history"],
            json!({"inputCount": 0, "reason": "not-applicable"}),
            "{}",
            outcome.variant_id
        );
        for request in &outcome.requests {
            assert_eq!(
                request["history"],
                json!({"inputCount": 0, "reason": "not-applicable"}),
                "{}",
                outcome.variant_id
            );
        }
    }
}

#[test]
fn setup_uses_only_product_writers() {
    for outcome in all_outcomes() {
        let label = &outcome.variant_id;
        assert!(
            outcome.direct_writes.is_empty(),
            "{label}: {:?}",
            outcome.direct_writes
        );
        assert_eq!(outcome.setup_case["directDmlObserved"], false, "{label}");
        let used = outcome.setup_case["writersUsed"]
            .as_array()
            .expect("writersUsed");
        assert!(!used.is_empty(), "{label}");
        for writer in used {
            let name = writer.as_str().unwrap_or_default();
            assert!(
                ALLOWED_WRITERS.contains(&name),
                "{label}: {name} is not a product writer"
            );
        }
        // The writers that changed a row are named too; each is a product
        // writer or the product's maintenance owner.
        for writer in outcome.setup_case["extensions"]["rowChangingWriters"]
            .as_array()
            .expect("rowChangingWriters")
        {
            let name = writer.as_str().unwrap_or_default();
            assert!(
                ALLOWED_WRITERS.contains(&name),
                "{label}: {name} changed rows"
            );
        }
    }
}

#[test]
fn write_audit_attributes_and_flags_direct_dml() -> Result<()> {
    let mut workspace = CaseWorkspace::open("audit")?;
    workspace.write_scene("a scene", "a0", "A body.")?;
    assert!(
        workspace.audit.direct_writes().is_empty(),
        "a product writer is not a direct write"
    );
    assert!(workspace
        .audit
        .writers_that_changed_rows()
        .contains(&"tree_node_create".to_owned()));
    // A statement run outside every writer is flagged.
    let snapshot = grimodex_db::state::active_workspace_snapshot(&workspace.state.ws)?;
    snapshot.db().db().with_conn(|conn| {
        conn.execute(
            "UPDATE projects SET title = title WHERE id = 'default-project'",
            [],
        )?;
        Ok(())
    })?;
    let direct = workspace.audit.direct_writes();
    assert!(
        direct.iter().any(|change| change.contains("projects")),
        "a direct UPDATE must be flagged: {direct:?}"
    );
    Ok(())
}

#[test]
fn case_workspace_is_isolated_and_removed() -> Result<()> {
    let first = CaseWorkspace::open("isolation/one")?;
    let second = CaseWorkspace::open("isolation/two")?;
    assert_ne!(first.root, second.root);
    assert_ne!(first.locator, second.locator);
    let (first_root, second_root) = (first.root.clone(), second.root.clone());
    assert!(first_root.join("grimodex.db").exists());
    drop(first);
    assert!(
        !first_root.exists(),
        "a dropped workspace must remove its root"
    );
    assert!(
        second_root.exists(),
        "removing one workspace must not touch another"
    );
    drop(second);
    assert!(!second_root.exists());
    Ok(())
}

#[test]
fn chat_session_statement_matches_pinned_vector() -> Result<()> {
    let statement = super::statement::build("project", "scene", "title")?;
    assert!(statement.matches_renderer);
    assert_eq!(statement.method, "all");
    assert!(statement.sql.starts_with("insert into \"chat_sessions\""));
    assert_eq!(statement.params.len(), 10);
    assert_eq!(statement.params[2], json!("scene"));
    Ok(())
}

// ------------------------------------------------- setup guard scenarios

fn mutated_variant(
    variant_id: &str,
    mutate: impl FnOnce(&mut Value),
) -> Result<(Fixture, usize, usize)> {
    let (_, mut raw, _) = fixture_text()?;
    let mut position = None;
    for (case_index, case) in raw["cases"].as_array().context("cases")?.iter().enumerate() {
        for (variant_index, variant) in case["variants"]
            .as_array()
            .context("variants")?
            .iter()
            .enumerate()
        {
            if variant["variantId"] == variant_id {
                position = Some((case_index, variant_index));
            }
        }
    }
    let (case_index, variant_index) =
        position.with_context(|| format!("no variant {variant_id}"))?;
    mutate(&mut raw["cases"][case_index]["variants"][variant_index]);
    let fixture: Fixture = serde_json::from_value(raw)?;
    Ok((fixture, case_index, variant_index))
}

fn run_mutated(
    variant_id: &str,
    mutate: impl FnOnce(&mut Value),
) -> Result<std::result::Result<VariantOutcome, String>> {
    let (fixture, case_index, variant_index) = mutated_variant(variant_id, mutate)?;
    let case = &fixture.cases[case_index];
    let variant = &case.variants[variant_index];
    Ok(run_variant(&fixture, case, variant).map_err(|error| format!("{error:#}")))
}

#[test]
fn setup_rejects_write_after_first_prepare() -> Result<()> {
    // Move the negative's invalidation after the positive prepare.
    let result = run_mutated("ma-reject-source", |variant| {
        let steps = variant["setup"]["steps"].as_array_mut().expect("steps");
        let invalidate = steps.remove(2);
        assert_eq!(invalidate["op"], "invalidate-negative");
        steps.insert(4, invalidate);
    })?;
    let error = result
        .err()
        .context("a write after the first prepare must stop the setup")?;
    assert!(
        error.contains("NIR1_EVAL_SETUP_WRITE_AFTER_FIRST_PREPARE"),
        "{error}"
    );
    Ok(())
}

#[test]
fn p10_without_new_revision_is_setup_failure() -> Result<()> {
    let result = run_mutated("mb-positive-scope", |variant| {
        let steps = variant["setup"]["steps"].as_array_mut().expect("steps");
        steps.retain(|step| step["stage"] == 1 || step["op"] == "binding-change");
    })?;
    let error = result
        .err()
        .context("a P-10 stage without a new Revision must not run")?;
    assert!(
        error.contains("NIR1_EVAL_SETUP_STAGE_WITHOUT_NEW_REVISION"),
        "{error}"
    );
    Ok(())
}

#[test]
fn p10_reapproval_of_old_revision_is_rejected() -> Result<()> {
    let result = run_mutated("mb-positive-scope", |variant| {
        let steps = variant["setup"]["steps"].as_array_mut().expect("steps");
        // Stage 2 approves the old Revision again instead of preparing a new one.
        steps.retain(|step| step["stage"] == 1 || step["op"] == "binding-change");
        steps.push(json!({
            "stage": 2, "op": "approve", "revision": "mb-rev-1",
            "decision": "approved", "decisionJson": {}, "createdBy": "mech-reviewer"
        }));
    })?;
    let error = result
        .err()
        .context("re-approving an old Revision must stop the setup")?;
    assert!(
        error.contains("NIR1_EVAL_SETUP_REAPPROVAL_OF_OLD_REVISION"),
        "{error}"
    );
    Ok(())
}

#[test]
fn p10_request2_uses_newly_prepared_revision_not_reapproved_old() {
    let outcomes = all_outcomes();
    for variant_id in [
        "mb-positive-scope",
        "mb-positive-source",
        "mb-positive-decision",
    ] {
        let outcome = outcome_of(outcomes, variant_id);
        let events = events(outcome);
        let prepares: Vec<&Value> = events
            .iter()
            .filter(|event| kind_of(event) == "prepare")
            .collect();
        assert_eq!(prepares.len(), 2, "{variant_id}");
        assert_ne!(
            prepares[0]["runtimeId"], prepares[1]["runtimeId"],
            "{variant_id}"
        );
        assert_eq!(prepares[0]["stage"], 1);
        assert_eq!(prepares[1]["stage"], 2);
        // The old Revision is approved once, in stage 1; stage 2 approves only the new one.
        let approvals: Vec<&Value> = events
            .iter()
            .filter(|event| kind_of(event) == "approve")
            .collect();
        assert_eq!(approvals.len(), 2, "{variant_id}");
        assert_eq!(
            approvals[1]["runtimeId"], prepares[1]["runtimeId"],
            "{variant_id}"
        );
        assert_eq!(approvals[1]["stage"], 2);
        // A binding change sits between the two stages' prepares.
        let change = events
            .iter()
            .find(|event| kind_of(event) == "binding-change")
            .unwrap_or_else(|| panic!("{variant_id}: no binding-change"));
        assert!(
            seq_of(change) > seq_of(prepares[0]) && seq_of(change) < seq_of(prepares[1]),
            "{variant_id}"
        );
        // Request 2 passes the new Revision (not the old one).
        let request2 = &outcome.requests[1];
        assert_eq!(
            request2["passedRevisionIds"],
            json!([prepares[1]["runtimeId"].clone()]),
            "{variant_id}"
        );
        // Both logical ids are in the id map with distinct runtime ids.
        let id_map = outcome.setup_case["idMap"].as_array().expect("idMap");
        let runtime = |logical: &str| {
            id_map
                .iter()
                .find(|row| row["logicalId"] == logical)
                .map(|row| row["runtimeId"].clone())
        };
        assert_ne!(runtime("mb-rev-1"), runtime("mb-rev-2"), "{variant_id}");
        assert!(runtime("mb-rev-1").is_some());
    }
}

// ----------------------------------------------------------- freeze gate

struct TempRepo {
    root: PathBuf,
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn git(root: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=freeze-test",
            "-c",
            "user.email=freeze-test@example.invalid",
        ])
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .current_dir(root)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

const GATE_FIXTURE_TEXT: &str = "{\"fixture\":true,\"fixtureVersion\":2}\n";

/// A review record as the independent reviewer writes it.
fn review_text(verdict: &str, fixture_text: &str, native_output_observed: bool) -> String {
    serde_json::to_string_pretty(&json!({
        "verdict": verdict,
        "fixtureSha256": sha256_hex(fixture_text.as_bytes()),
        "reviewer": { "nativeOutputObserved": native_output_observed },
    }))
    .expect("a review record serialises")
}

/// The eight files a freeze record binds (path, text), with an approving review.
fn bound_files() -> Vec<(&'static str, String)> {
    vec![
        (FIXTURE_PATH, GATE_FIXTURE_TEXT.to_owned()),
        (
            REVIEW_PATH,
            review_text("approve", GATE_FIXTURE_TEXT, false),
        ),
        (
            "evals/nir1-packing/final-request.v2.README.md",
            "readme\n".to_owned(),
        ),
        (
            "evals/nir1-packing/final-request-baseline-parity.v1.json",
            "{\"parity\":true}\n".to_owned(),
        ),
        (
            "scripts/quality/nir1-packing/final-request/scorer.mjs",
            "// scorer\n".to_owned(),
        ),
        (
            "scripts/quality/nir1-packing/final-request/contract.mjs",
            "// contract\n".to_owned(),
        ),
        (
            "scripts/quality/nir1-packing/final-request/receipt.mjs",
            "// receipt\n".to_owned(),
        ),
        (
            "scripts/quality/nir1-packing/final-request/payload.mjs",
            "// payload\n".to_owned(),
        ),
    ]
}

fn write_file(root: &Path, path: &str, text: &str) -> Result<()> {
    let target = root.join(path);
    std::fs::create_dir_all(target.parent().context("parent")?)?;
    std::fs::write(target, text)?;
    Ok(())
}

fn freeze_record_for(status: &str, files: &[(&'static str, String)]) -> Value {
    let entry =
        |path: &str, text: &str| json!({"path": path, "sha256": sha256_hex(text.as_bytes())});
    json!({
        "fixtureVersion": EVIDENCE_FIXTURE_VERSION,
        "status": status,
        "reviewVerdict": if status == "frozen" { "approve" } else { "pending" },
        "nativeOutputObservedBeforeFreeze": false,
        "fixture": entry(files[0].0, &files[0].1),
        "reviewRecord": entry(files[1].0, &files[1].1),
        "readme": entry(files[2].0, &files[2].1),
        "parityVector": entry(files[3].0, &files[3].1),
        "scorer": { "files": files[4..].iter().map(|(path, text)| entry(path, text)).collect::<Vec<_>>() },
    })
}

fn freeze_record(status: &str) -> Value {
    freeze_record_for(status, &bound_files())
}

/// A repository whose first commit holds every bound file and a freeze record
/// of the given status.
fn temp_repo(status: &str) -> Result<TempRepo> {
    temp_repo_with(status, &bound_files(), |_| {})
}

/// Like `temp_repo`, with the bound files given and the record adjusted by
/// `mutate` (the record's hashes are taken from `files` first).
fn temp_repo_with(
    status: &str,
    files: &[(&'static str, String)],
    mutate: impl FnOnce(&mut Value),
) -> Result<TempRepo> {
    let root = std::env::temp_dir().join(format!("nir1-freeze-gate-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root)?;
    let repo = TempRepo { root };
    git(&repo.root, &["init", "--quiet", "--initial-branch=main"])?;
    for (path, text) in files {
        write_file(&repo.root, path, text)?;
    }
    let mut record = freeze_record_for(status, files);
    mutate(&mut record);
    write_file(
        &repo.root,
        FREEZE_PATH,
        &serde_json::to_string_pretty(&record)?,
    )?;
    git(&repo.root, &["add", "--all"])?;
    git(&repo.root, &["commit", "--quiet", "-m", "freeze"])?;
    Ok(repo)
}

#[test]
fn harness_accepts_a_matching_frozen_snapshot() -> Result<()> {
    let repo = temp_repo("frozen")?;
    write_file(&repo.root, "unrelated.txt", "later work\n")?;
    git(&repo.root, &["add", "--all"])?;
    git(&repo.root, &["commit", "--quiet", "-m", "later"])?;
    let freeze_commit = git(&repo.root, &["rev-list", "--max-parents=0", "HEAD"])?;
    let head = git(&repo.root, &["rev-parse", "HEAD"])?;
    let snapshot = check_freeze(&repo.root, Some(&freeze_commit))
        .map_err(|refusal| anyhow::anyhow!("{:?}", refusal.reasons))?;
    assert_eq!(snapshot.freeze_commit, freeze_commit);
    assert_eq!(snapshot.run_commit, head);
    assert_ne!(
        snapshot.freeze_commit, snapshot.run_commit,
        "the freeze commit is an ancestor, not HEAD"
    );
    let files = bound_files();
    assert_eq!(snapshot.fixture_sha256, sha256_hex(files[0].1.as_bytes()));
    assert_eq!(snapshot.fixture_text, files[0].1);
    // The scorer digest is sha256 over `<path>\t<sha256>\n`, sorted by path.
    let mut lines: Vec<String> = files[4..]
        .iter()
        .map(|(path, text)| format!("{path}\t{}\n", sha256_hex(text.as_bytes())))
        .collect();
    lines.sort();
    assert_eq!(
        snapshot.scorer_sha256,
        sha256_hex(lines.concat().as_bytes())
    );
    Ok(())
}

fn refusal_reasons(root: &Path, expected: Option<&str>) -> Vec<String> {
    match check_freeze(root, expected) {
        Ok(_) => panic!("the freeze gate must refuse"),
        Err(refusal) => refusal.reasons,
    }
}

#[test]
fn harness_refuses_without_matching_freeze() -> Result<()> {
    // A record that is not frozen.
    let pending = temp_repo("pending-review")?;
    let reasons = refusal_reasons(&pending.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("freeze-record-not-frozen")),
        "{reasons:?}"
    );
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("no commit holds a frozen freeze record")),
        "{reasons:?}"
    );

    // A frozen record, then a bound file changed after the freeze.
    let changed = temp_repo("frozen")?;
    write_file(&changed.root, FIXTURE_PATH, "{\"fixture\":\"changed\"}\n")?;
    git(&changed.root, &["add", "--all"])?;
    git(
        &changed.root,
        &["commit", "--quiet", "-m", "change the fixture"],
    )?;
    let reasons = refusal_reasons(&changed.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains(FIXTURE_PATH) && reason.contains("sha256")),
        "{reasons:?}"
    );
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("changed after the freeze")),
        "{reasons:?}"
    );

    // A dirty checkout is not a candidate.
    let dirty = temp_repo("frozen")?;
    write_file(&dirty.root, "scratch.txt", "uncommitted\n")?;
    let reasons = refusal_reasons(&dirty.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("workspace-not-clean")),
        "{reasons:?}"
    );

    // A receipt that names another freeze commit.
    let frozen = temp_repo("frozen")?;
    let wrong = "0".repeat(40);
    let reasons = refusal_reasons(&frozen.root, Some(&wrong));
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("is not the first commit that held the frozen record")),
        "{reasons:?}"
    );

    // No freeze record at all.
    let missing = temp_repo("frozen")?;
    git(&missing.root, &["rm", "--quiet", FREEZE_PATH])?;
    git(
        &missing.root,
        &["commit", "--quiet", "-m", "drop the record"],
    )?;
    let reasons = refusal_reasons(&missing.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("could not be read")),
        "{reasons:?}"
    );
    Ok(())
}

#[test]
fn harness_refuses_an_unapproved_or_observed_freeze() -> Result<()> {
    // `status: frozen` is not enough: the freeze record's own verdict, its
    // statement about Native observations and the review record all gate Native.
    let pending_verdict = temp_repo_with("frozen", &bound_files(), |record| {
        record["reviewVerdict"] = json!("pending");
    })?;
    let reasons = refusal_reasons(&pending_verdict.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("review-not-approved")),
        "{reasons:?}"
    );

    let observed = temp_repo_with("frozen", &bound_files(), |record| {
        record["nativeOutputObservedBeforeFreeze"] = json!(true);
    })?;
    let reasons = refusal_reasons(&observed.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("native-observed-before-freeze")),
        "{reasons:?}"
    );

    let mut changes = bound_files();
    changes[1].1 = review_text("changes-required", GATE_FIXTURE_TEXT, false);
    let changes_required = temp_repo_with("frozen", &changes, |_| {})?;
    let reasons = refusal_reasons(&changes_required.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("review record's verdict")),
        "{reasons:?}"
    );

    let mut other_fixture = bound_files();
    other_fixture[1].1 = review_text("approve", "{\"another\":\"fixture\"}\n", false);
    let wrong_fixture = temp_repo_with("frozen", &other_fixture, |_| {})?;
    let reasons = refusal_reasons(&wrong_fixture.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("reviewed fixture sha256")),
        "{reasons:?}"
    );

    let mut saw_native = bound_files();
    saw_native[1].1 = review_text("approve", GATE_FIXTURE_TEXT, true);
    let seen = temp_repo_with("frozen", &saw_native, |_| {})?;
    let reasons = refusal_reasons(&seen.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("saw no Native output")),
        "{reasons:?}"
    );
    Ok(())
}

#[test]
fn freeze_commit_is_ancestor_of_head() -> Result<()> {
    // The record is first frozen in the second commit; the first commit holds
    // it pending. The freeze commit is the second, and it is an ancestor of HEAD.
    let repo = temp_repo("pending-review")?;
    write_file(
        &repo.root,
        FREEZE_PATH,
        &serde_json::to_string_pretty(&freeze_record("frozen"))?,
    )?;
    git(&repo.root, &["add", "--all"])?;
    git(
        &repo.root,
        &["commit", "--quiet", "-m", "approve the review"],
    )?;
    let frozen_at = git(&repo.root, &["rev-parse", "HEAD"])?;
    write_file(&repo.root, "run.txt", "the run commit\n")?;
    git(&repo.root, &["add", "--all"])?;
    git(&repo.root, &["commit", "--quiet", "-m", "run"])?;
    let snapshot = check_freeze(&repo.root, None)
        .map_err(|refusal| anyhow::anyhow!("{:?}", refusal.reasons))?;
    assert_eq!(snapshot.freeze_commit, frozen_at);
    git(
        &repo.root,
        &[
            "merge-base",
            "--is-ancestor",
            &snapshot.freeze_commit,
            &snapshot.run_commit,
        ],
    )?;
    Ok(())
}

// ------------------------------------------------- the mechanics fixture

/// Strings of the frozen fixture that identify its materials: logical IDs,
/// Scene and Entity texts, user messages, canaries and the route's model.
fn material_strings(value: &Value, out: &mut Vec<String>) {
    const KEYS: [&str; 9] = [
        "logicalId",
        "ineligibleLogicalId",
        "title",
        "body",
        "name",
        "summary",
        "userMessage",
        "text",
        "model",
    ];
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                if let (true, Some(text)) = (KEYS.contains(&key.as_str()), inner.as_str()) {
                    if text.chars().count() >= 4 {
                        out.push(text.to_owned());
                    }
                }
                material_strings(inner, out);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| material_strings(item, out)),
        _ => {}
    }
}

/// The frozen fixture is read here as text only; the harness mechanics tests
/// run on `mechanics-fixture.json`, so none of the frozen materials reaches
/// Native before the freeze gate has passed.
#[test]
fn mechanics_fixture_shares_no_material_with_the_frozen_fixture() -> Result<()> {
    let root = super::freeze::repository_root()?;
    // Both versions: the superseded version 1 (always placed, the HOLD
    // history) and the evidence version 2 once it is placed.
    let mut materials = Vec::new();
    for (path, required) in [
        (root.join(SUPERSEDED_FIXTURE_PATH), true),
        (root.join(FIXTURE_PATH), false),
    ] {
        if !required && !path.exists() {
            continue;
        }
        let frozen: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        let before = materials.len();
        material_strings(&frozen, &mut materials);
        assert!(
            materials.len() - before > 100,
            "{}",
            materials.len() - before
        );
        for canary in frozen["canaries"].as_array().context("canaries")? {
            materials.push(canary["text"].as_str().context("canary text")?.to_owned());
        }
    }
    for material in &materials {
        assert!(
            !MECHANICS_FIXTURE.contains(material.as_str()),
            "the mechanics fixture contains a material of the frozen fixture: {material}"
        );
    }
    // And the other way: the mechanics fixture is parseable and is not a P case.
    let (fixture, _, _) = fixture_text()?;
    for case in &fixture.cases {
        assert!(
            case.case_id.starts_with("M-"),
            "{} is not a mechanics case",
            case.case_id
        );
    }
    Ok(())
}

// --------------------------------------------------------- evidence entry

/// The gate decides whether Native runs on the fixture at all. While the
/// freeze record is not frozen (or the checkout is not a clean candidate) the
/// evidence entry must refuse and leave a hold record, not receipts.
#[test]
fn evidence_run_holds_while_the_freeze_is_not_frozen() -> Result<()> {
    let root = super::freeze::repository_root()?;
    if check_freeze(&root, None).is_ok() {
        // The gate passes: the evidence entry would run every variant. That run
        // is the ignored `final_request_evidence_run`, not part of this check.
        return Ok(());
    }
    let out = root
        .join(".artifacts/nir1-final-request-eval/test")
        .join(format!("hold-{}", uuid::Uuid::new_v4()));
    let outcome = evidence_run(&root, Some(out.clone()))?;
    let EvidenceOutcome::Held { hold_path, reasons } = outcome else {
        anyhow::bail!("the evidence entry ran although the freeze gate refused");
    };
    assert!(!reasons.is_empty());
    let record: Value = serde_json::from_str(&std::fs::read_to_string(&hold_path)?)?;
    assert_eq!(record["status"], "hold");
    assert!(record["reasons"]
        .as_array()
        .is_some_and(|reasons| !reasons.is_empty()));
    // A hold is not a receipt: no receipt file was written.
    assert!(!out.join("receipt.json").exists());
    assert!(!out.join("setup-receipt.json").exists());
    let _ = std::fs::remove_dir_all(&out);
    Ok(())
}

/// The evidence entry. It writes `receipt.json` and `setup-receipt.json` (or a
/// `hold.json` when the freeze gate refuses) under
/// `.artifacts/nir1-final-request-eval/run-<commit>-<seconds>/`, or under
/// `NIR1_FINAL_REQUEST_EVAL_OUT` (a directory inside `.artifacts/`). The
/// scorer reads them: `node scripts/quality/nir1-packing/final-request/runner.mjs`.
/// Whether the run passed is the scorer's verdict; this test only reports what
/// was written.
#[test]
#[ignore = "evidence entry; run with --ignored --exact (see the runner's header)"]
fn final_request_evidence_run() -> Result<()> {
    let root = super::freeze::repository_root()?;
    let out = std::env::var_os("NIR1_FINAL_REQUEST_EVAL_OUT").map(PathBuf::from);
    match evidence_run(&root, out)? {
        EvidenceOutcome::Held { hold_path, reasons } => {
            eprintln!("HOLD: Native was not run. {}", hold_path.display());
            for reason in reasons {
                eprintln!("  - {reason}");
            }
        }
        EvidenceOutcome::Ran {
            receipt_path,
            setup_receipt_path,
        } => {
            eprintln!("receipt: {}", receipt_path.display());
            eprintln!("setup receipt: {}", setup_receipt_path.display());
        }
    }
    Ok(())
}

// ------------------------------- versions and the unknown-Scope negative (S0c)

#[test]
fn harness_refuses_a_superseded_or_mismatched_fixture_version() -> Result<()> {
    // Only a version-1 record (the superseded HOLD history): the gate reads the
    // version-2 record, which does not exist, so Native never runs.
    let only_v1 = temp_repo("frozen")?;
    git(&only_v1.root, &["mv", FREEZE_PATH, SUPERSEDED_FREEZE_PATH])?;
    git(
        &only_v1.root,
        &["commit", "--quiet", "-m", "a v1 record only"],
    )?;
    let reasons = refusal_reasons(&only_v1.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains(FREEZE_PATH) && reason.contains("could not be read")),
        "{reasons:?}"
    );

    // A record that names another version.
    let other = temp_repo_with("frozen", &bound_files(), |record| {
        record["fixtureVersion"] = json!(1);
    })?;
    let reasons = refusal_reasons(&other.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("fixture-version-mismatch")
                && reason.contains("freeze record")),
        "{reasons:?}"
    );

    // A fixture under the version-2 path that names version 1.
    let mut v1_text = bound_files();
    v1_text[0].1 = "{\"fixture\":true,\"fixtureVersion\":1}\n".to_owned();
    v1_text[1].1 = review_text("approve", &v1_text[0].1, false);
    let named = temp_repo_with("frozen", &v1_text, |_| {})?;
    let reasons = refusal_reasons(&named.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("fixture-version-mismatch")
                && reason.contains(FIXTURE_PATH)),
        "{reasons:?}"
    );

    // A record that binds the version-1 review record.
    let mut v1_review = bound_files();
    v1_review[1].0 = "evals/nir1-packing/final-request.expectation-review.v1.json";
    let wrong_review = temp_repo_with("frozen", &v1_review, |_| {})?;
    let reasons = refusal_reasons(&wrong_review.root, None);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.contains("binds the review record")),
        "{reasons:?}"
    );
    Ok(())
}

/// A minimal fixture for the setup-shape checks: one case (anchor, query) with
/// a positive variant and a reject variant whose negative anchors its own
/// Scene and is invalidated by `scene-scope-unknown`.
fn shape_fixture(version: u32) -> Value {
    let positive_steps = json!([
        {"stage": 1, "op": "prepare", "revision": "s-pos", "entity": "s-ent", "anchorScene": "s-anchor", "proposalKey": "k-pos"},
        {"stage": 1, "op": "approve", "revision": "s-pos"},
    ]);
    let mut reject_steps = json!([
        {"stage": 1, "op": "prepare-negative", "revision": "s-neg", "entity": "s-neg-ent", "anchorScene": "s-neg-anchor", "proposalKey": "k-neg"},
        {"stage": 1, "op": "approve-negative", "revision": "s-neg"},
        {"stage": 1, "op": "invalidate-negative", "revision": "s-neg", "write": "scene-scope-unknown", "scene": "s-neg-anchor", "unresolvedReason": "shape test"},
    ]);
    reject_steps
        .as_array_mut()
        .expect("steps")
        .extend(positive_steps.as_array().expect("steps").iter().cloned());
    json!({
        "fixtureVersion": version,
        "estimatorVersion": "x",
        "route": {"model": "m", "contextWindowTokens": 1000, "outputTokens": 10},
        "setupContract": {"sceneScope": {"registry": {}, "perScene": {}}},
        "cases": [{
            "caseId": "S-1",
            "userMessage": "u",
            "isolation": {"workspaceId": "s-ws"},
            "setup": {
                "project": {"logicalId": "s-project"},
                "scenes": [
                    {"logicalId": "s-anchor", "role": "anchor", "title": "t", "body": "b"},
                    {"logicalId": "s-query", "role": "query", "title": "t", "body": "b"},
                ],
                "codexEntities": [],
            },
            "variants": [
                {"variantId": "s-positive", "kind": "positive",
                 "setup": {"steps": positive_steps, "chatSessions": []},
                 "requests": [{"stage": 1, "revisionIds": ["s-pos"]}]},
                {"variantId": "s-reject", "kind": "reject", "ineligibleLogicalId": "s-neg",
                 "setup": {
                     "scenes": [{"logicalId": "s-neg-anchor", "role": "negative-anchor", "title": "t", "body": "b"}],
                     "steps": reject_steps, "chatSessions": []},
                 "requests": [{"stage": 1, "revisionIds": ["s-pos", "s-neg"]}]},
            ],
        }],
    })
}

/// One mutation of the shape fixture.
type ShapeMutation = Box<dyn Fn(&mut Value)>;

fn shape_errors(raw: Value) -> Vec<String> {
    let fixture: Fixture = serde_json::from_value(raw).expect("the shape fixture parses");
    let case = &fixture.cases[0];
    case.variants
        .iter()
        .filter_map(|variant| validate_variant_setup(&fixture, case, variant).err())
        .map(|error| format!("{error:#}"))
        .collect()
}

#[test]
fn setup_shapes_allow_an_unknown_scope_negative_on_its_own_anchor_only() {
    assert!(shape_errors(shape_fixture(2)).is_empty());
    // The same shapes are refused in a version-1 fixture.
    let errors = shape_errors(shape_fixture(1));
    assert!(
        errors
            .iter()
            .any(|error| error.contains("may not declare a negative-anchor Scene")),
        "{errors:?}"
    );
    let cases: Vec<(&str, ShapeMutation)> = vec![
        (
            "may not target the case's anchor or query",
            Box::new(|raw: &mut Value| {
                raw["cases"][0]["variants"][1]["setup"]["steps"][2]["scene"] = json!("s-anchor");
            }),
        ),
        (
            "may not target the case's anchor or query",
            Box::new(|raw: &mut Value| {
                raw["cases"][0]["variants"][1]["setup"]["steps"][2]["scene"] = json!("s-query");
            }),
        ),
        (
            "is an invalidate-negative write only",
            Box::new(|raw: &mut Value| {
                raw["cases"][0]["variants"][1]["setup"]["steps"][2]["op"] = json!("binding-change");
            }),
        ),
        (
            "unknown setup write",
            Box::new(|raw: &mut Value| {
                raw["cases"][0]["variants"][1]["setup"]["steps"][2]["write"] =
                    json!("scene-delete");
            }),
        ),
        (
            "unresolvedReason must be",
            Box::new(|raw: &mut Value| {
                raw["cases"][0]["variants"][1]["setup"]["steps"][2]["unresolvedReason"] =
                    json!(" x ");
            }),
        ),
        (
            "a positive Revision may not anchor",
            Box::new(|raw: &mut Value| {
                raw["cases"][0]["variants"][1]["setup"]["steps"][3]["anchorScene"] =
                    json!("s-neg-anchor");
            }),
        ),
        (
            "is not the anchor of the invalidated negative",
            Box::new(|raw: &mut Value| {
                raw["cases"][0]["variants"][1]["setup"]["steps"][0]["anchorScene"] =
                    json!("s-anchor");
            }),
        ),
        (
            "neither the case's anchor nor a negative-anchor",
            Box::new(|raw: &mut Value| {
                raw["cases"][0]["variants"][1]["setup"]["steps"][0]["anchorScene"] =
                    json!("s-other");
            }),
        ),
        (
            "only a reject variant may declare",
            Box::new(|raw: &mut Value| {
                let scenes = raw["cases"][0]["variants"][1]["setup"]["scenes"].clone();
                raw["cases"][0]["variants"][0]["setup"]["scenes"] = scenes;
            }),
        ),
        (
            "is a Scene of the case",
            Box::new(|raw: &mut Value| {
                raw["cases"][0]["variants"][1]["setup"]["scenes"][0]["logicalId"] =
                    json!("s-query");
            }),
        ),
        (
            "must be a negative-anchor",
            Box::new(|raw: &mut Value| {
                raw["cases"][0]["variants"][1]["setup"]["scenes"][0]["role"] = json!("anchor");
            }),
        ),
        (
            "at most one negative-anchor Scene",
            Box::new(|raw: &mut Value| {
                let scene = raw["cases"][0]["variants"][1]["setup"]["scenes"][0].clone();
                raw["cases"][0]["variants"][1]["setup"]["scenes"]
                    .as_array_mut()
                    .expect("scenes")
                    .push(scene);
            }),
        ),
    ];
    for (expected, mutate) in cases {
        let mut raw = shape_fixture(2);
        mutate(&mut raw);
        let errors = shape_errors(raw);
        assert!(
            errors.iter().any(|error| error.contains(expected)),
            "{expected}: {errors:?}"
        );
    }
}

#[test]
fn unknown_scope_value_is_unknown_with_an_unresolved_query_identity() {
    let (_, raw, _) = fixture_text().expect("the mechanics fixture");
    let per_scene = &raw["setupContract"]["sceneScope"]["perScene"];
    let explicit = super::workspace::scene_scope_value(per_scene, None);
    let unknown = super::workspace::scene_scope_value(per_scene, Some("not yet placed"));
    assert_eq!(explicit["compatibilityMarker"], "explicit");
    assert_eq!(unknown["compatibilityMarker"], "unknown");
    for axis in ["timeline", "worldline", "narrativeLayer"] {
        assert_eq!(explicit["queryIdentity"][axis]["kind"], "exact");
        assert_eq!(
            unknown["queryIdentity"][axis],
            json!({"kind": "unresolved", "reason": "not yet placed"})
        );
    }
    assert_eq!(
        unknown["materialConstraint"],
        explicit["materialConstraint"]
    );
    assert_eq!(unknown["knowledgeHolder"], explicit["knowledgeHolder"]);
    assert_eq!(unknown["audience"], explicit["audience"]);
}

/// The product writer accepts the unknown Scope, and the setup's own reader
/// (`evaluate_nir1_entity_relation_disclosure`, the setup verification; no
/// packer, renderer or D-final runs) sees the negative anchored on that Scene
/// as not eligible and a positive prepared afterwards on the case's anchor as
/// eligible. Synthetic materials only.
#[test]
fn unknown_scope_write_makes_only_the_negative_ineligible() -> Result<()> {
    let (_, raw, _) = fixture_text()?;
    let scope = &raw["setupContract"]["sceneScope"];
    let mut ws = CaseWorkspace::open("s0c/unknown-scope")?;
    ws.write_project("S0c unknown scope")?;
    let anchor = ws.write_scene("合成の起点", "a0", "合成の起点の本文。")?;
    let query = ws.write_scene("合成の問い", "a1", "合成の問いの本文。")?;
    let negative_anchor = ws.write_scene("合成の負例の場面", "a2", "合成の負例専用の本文。")?;
    ws.write_scope_registry(&anchor, Some(&scope["registry"]), None)?;
    for scene in [&anchor, &query, &negative_anchor] {
        ws.write_scene_scope(scene, &scope["perScene"])?;
    }
    let negative_entity = ws.write_codex_entity("lore", "合成の負例", "合成の負例の要約。")?;
    let positive_entity = ws.write_codex_entity("lore", "合成の正例", "合成の正例の要約。")?;
    ws.run_product_maintenance(12)?;

    let negative = ws.prepare_revision(&negative_anchor, &negative_entity, "s0c:negative")?;
    ws.append_decision(&negative, "approved", None, "s0c-reviewer")?;
    ws.run_product_maintenance(12)?;
    ws.write_scene_scope_unknown(
        &negative_anchor,
        &scope["perScene"],
        "合成の負例の Scope は未確定",
    )?;
    ws.run_product_maintenance(12)?;
    assert_eq!(ws.scene_scope_marker(&negative_anchor)?, "unknown");
    assert_eq!(ws.scene_scope_marker(&anchor)?, "explicit");

    let positive = ws.prepare_revision(&anchor, &positive_entity, "s0c:positive")?;
    ws.append_decision(&positive, "approved", None, "s0c-reviewer")?;
    ws.run_product_maintenance(12)?;
    let negative_read = ws.read_revision(&negative.revision_id, &query)?;
    let positive_read = ws.read_revision(&positive.revision_id, &query)?;
    assert!(
        negative_read.a2 != "eligible" || negative_read.a3 != "eligible",
        "the negative on the unknown Scene must not be eligible"
    );
    assert_eq!(
        (
            positive_read.a2.as_str(),
            positive_read.a3.as_str(),
            positive_read.freshness.as_str()
        ),
        ("eligible", "eligible", "fresh"),
        "a positive on the case's anchor stays eligible"
    );
    assert!(
        ws.audit.direct_writes().is_empty(),
        "every write went through a product writer"
    );
    Ok(())
}
