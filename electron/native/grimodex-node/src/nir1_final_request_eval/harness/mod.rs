//! The DPH-4 harness (cargo test only). It builds one workspace per variant
//! with product writers, restricts the profile, calls D-final once per request
//! and writes the receipt and the setup receipt that the scorer reads
//! (`scripts/quality/nir1-packing/final-request/`). It sends nothing, keeps no
//! process running and stores nothing in a product database.
//!
//! - `freeze`: the gate that must pass before Native runs on the fixture.
//! - `fixture`: the parts of the frozen fixture that drive setup and requests.
//! - `workspace`: a case workspace, the product writers and the write audit.
//! - `statement`: the renderer's `createSession` statement.
//! - `run`: one variant, end to end.
//! - `output`: receipt assembly and files under `.artifacts/`.

mod fixture;
mod freeze;
mod output;
mod run;
mod statement;
#[cfg(test)]
mod tests;
mod workspace;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use fixture::Fixture;
use freeze::{check_freeze, FrozenSnapshot};
use run::{run_variant, VariantOutcome};

/// What the evidence entry did.
#[derive(Debug)]
enum EvidenceOutcome {
    /// The freeze gate (or an unsupported fixture) refused: Native did not run.
    Held {
        hold_path: PathBuf,
        reasons: Vec<String>,
    },
    /// Native ran on every variant; both receipts are written.
    Ran {
        receipt_path: PathBuf,
        setup_receipt_path: PathBuf,
    },
}

/// Every variant of every case, one after the other. A setup that fails makes
/// the whole run invalid (`Err`): no receipt of a partly built run is written.
fn run_all_variants(fixture: &Fixture) -> Result<Vec<VariantOutcome>> {
    let mut outcomes = Vec::new();
    for case in &fixture.cases {
        for variant in &case.variants {
            outcomes.push(run_variant(fixture, case, variant).with_context(|| {
                format!(
                    "{}/{} could not be set up",
                    case.case_id, variant.variant_id
                )
            })?);
        }
    }
    Ok(outcomes)
}

/// The evidence entry: the freeze gate, then every variant, then the receipts.
/// `out_dir` must be under `.artifacts/` (`write_json_file` enforces it).
fn evidence_run(repo_root: &Path, out_dir: Option<PathBuf>) -> Result<EvidenceOutcome> {
    let head = freeze::head_commit(repo_root).ok();
    let out_dir = out_dir.unwrap_or_else(|| {
        output::default_output_dir(repo_root, head.as_deref().unwrap_or("none"))
    });
    let snapshot: FrozenSnapshot = match check_freeze(repo_root, None) {
        Ok(snapshot) => snapshot,
        Err(refusal) => {
            let hold_path = output::write_hold(&out_dir, head.as_deref(), &refusal.reasons)?;
            return Ok(EvidenceOutcome::Held {
                hold_path,
                reasons: refusal.reasons,
            });
        }
    };
    let fixture = Fixture::parse(&snapshot.fixture_text)?;
    if !fixture.diagnostic_cases.is_empty() {
        // The fixture would need a setup recipe for its diagnostic cases; the
        // harness has none, so the run is incomplete, not partly valid.
        let reasons = vec![
            "the fixture declares diagnosticCases but the harness has no setup for them (P-12 is a DD-1 measurement)"
                .to_owned(),
        ];
        let hold_path = output::write_hold(&out_dir, head.as_deref(), &reasons)?;
        return Ok(EvidenceOutcome::Held { hold_path, reasons });
    }
    let outcomes = run_all_variants(&fixture)?;
    let receipts = output::assemble(&fixture, &snapshot, &outcomes, false)?;
    let (receipt_path, setup_receipt_path) = output::write_receipts(&out_dir, &receipts)?;
    Ok(EvidenceOutcome::Ran {
        receipt_path,
        setup_receipt_path,
    })
}
