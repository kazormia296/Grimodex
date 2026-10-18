//! Receipt and setup receipt assembly, and the evidence run's output. The
//! receipts go under `.artifacts/` (never committed, never in a product
//! database); `write_json_file` refuses any other directory and never
//! overwrites.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use super::fixture::Fixture;
use super::freeze::FrozenSnapshot;
use super::run::VariantOutcome;
use crate::nir1_prepared_request::nir1_final_request_eval::write_json_file;

pub(super) const RECEIPT_SCHEMA_VERSION: &str = "nir1-final-request-receipt/1";
pub(super) const SETUP_RECEIPT_SCHEMA_VERSION: &str = "nir1-final-request-setup-receipt/1";
pub(super) const HOLD_SCHEMA_VERSION: &str = "nir1-final-request-eval-hold/1";
pub(super) const CONTRACT_ID: &str = "nir1-final-request-packing-eval";
pub(super) const DRAFT_REF: &str = "nir1-final-request-eval-proposal/2";
pub(super) const EVAL_FEATURE: &str = "nir1-final-request-eval";
pub(super) const OUTPUT_ROOT: &str = ".artifacts/nir1-final-request-eval";

/// Both receipts of one run.
pub(super) struct RunReceipts {
    pub(super) receipt: Value,
    pub(super) setup_receipt: Value,
}

/// `development` marks a receipt made without the freeze gate (the harness's
/// own mechanics tests). The runner refuses such a receipt.
pub(super) fn assemble(
    fixture: &Fixture,
    snapshot: &FrozenSnapshot,
    outcomes: &[VariantOutcome],
    development: bool,
) -> Result<RunReceipts> {
    let requests: Vec<Value> = outcomes
        .iter()
        .flat_map(|outcome| outcome.requests.iter().cloned())
        .collect();
    let template = requests
        .iter()
        .find_map(|request| request["capture"]["template"].as_object().cloned())
        .map(Value::Object)
        .context("no request was captured, so the fixed template is unknown")?;
    let mut receipt = json!({
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "contractId": CONTRACT_ID,
        "draftRef": DRAFT_REF,
        "producer": {
            "entry": "cargo-test",
            "evalFeature": EVAL_FEATURE,
            "featureSet": [EVAL_FEATURE],
        },
        "run": {
            "commit": snapshot.run_commit,
            "tree": snapshot.run_tree,
            "workspaceClean": true,
        },
        "freeze": {
            "path": snapshot.freeze_path,
            "recordSha256": snapshot.freeze_record_sha256,
            "commit": snapshot.freeze_commit,
        },
        "inputs": {
            "fixtureSha256": snapshot.fixture_sha256,
            "scorerSha256": snapshot.scorer_sha256,
            "fixtureVersion": fixture.fixture_version,
            "estimatorVersion": fixture.estimator_version,
            "fixedTemplate": template,
        },
        "requests": requests,
    });
    let mut setup_receipt = json!({
        "schemaVersion": SETUP_RECEIPT_SCHEMA_VERSION,
        "contractId": CONTRACT_ID,
        "run": { "commit": snapshot.run_commit, "tree": snapshot.run_tree },
        "cases": outcomes.iter().map(|outcome| outcome.setup_case.clone()).collect::<Vec<_>>(),
    });
    if development {
        receipt["extensions"] = json!({ "developmentRun": true });
        setup_receipt["extensions"] = json!({ "developmentRun": true });
    }
    Ok(RunReceipts {
        receipt,
        setup_receipt,
    })
}

/// `<repo>/.artifacts/nir1-final-request-eval/run-<commit8>-<unix seconds>`.
pub(super) fn default_output_dir(repo_root: &Path, commit: &str) -> PathBuf {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    repo_root
        .join(OUTPUT_ROOT)
        .join(format!("run-{}-{seconds}", &commit[..commit.len().min(8)]))
}

pub(super) fn write_receipts(dir: &Path, receipts: &RunReceipts) -> Result<(PathBuf, PathBuf)> {
    let receipt = write_json_file(dir, "receipt.json", &receipts.receipt)?;
    let setup = write_json_file(dir, "setup-receipt.json", &receipts.setup_receipt)?;
    Ok((receipt, setup))
}

/// A refused run leaves a record of why (a HOLD, not a PASS and not a FAIL).
pub(super) fn write_hold(dir: &Path, head: Option<&str>, reasons: &[String]) -> Result<PathBuf> {
    write_json_file(
        dir,
        "hold.json",
        &json!({
            "schemaVersion": HOLD_SCHEMA_VERSION,
            "contractId": CONTRACT_ID,
            "status": "hold",
            "head": head,
            "reasons": reasons,
            "note": "Native was not run on the fixture: the freeze gate refused. This record is not evidence for DP-1 or P-12.",
        }),
    )
}
