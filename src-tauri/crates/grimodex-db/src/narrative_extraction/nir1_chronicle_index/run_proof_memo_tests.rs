//! The per-prepare Run proof memo (DR-IRB-4) never changes what a prepare
//! decides: it only skips re-verifying a Run that the same read snapshot has
//! already verified for another Root.
use std::cell::Cell;

use super::{source::read_eligibility_source, test_support::Fixture};
use crate::narrative_extraction::{
    material_membership::{
        read_revision_material_membership, read_revision_material_membership_with_memo,
        MaterialMembershipRead,
    },
    material_membership_root::RunProofMemo,
    project_scope_authority::load_live_project_scope_authority,
    retrieval_admission::build::{preflight_build_candidate, preflight_build_candidate_with_memo},
    stage_provenance::{RECEIPT_HYDRATION_COUNT, RECEIPT_LIFECYCLE_BINDING_COUNT},
};

fn reset_counters() {
    RECEIPT_HYDRATION_COUNT.with(|count| count.set(0));
    RECEIPT_LIFECYCLE_BINDING_COUNT.with(|count| count.set(0));
}

fn counter(counter: &'static std::thread::LocalKey<Cell<usize>>) -> usize {
    counter.with(Cell::get)
}

/// The decision a candidate gets, with every field a later stage reads.
fn describe(
    result: anyhow::Result<
        std::result::Result<
            crate::narrative_extraction::retrieval_admission::build::BuildCandidatePreflight,
            crate::narrative_extraction::retrieval_admission::RevisionEligibilityReason,
        >,
    >,
) -> String {
    match result {
        Err(error) => format!("error: {error}"),
        Ok(Err(reason)) => format!("unavailable: {reason:?}"),
        Ok(Ok(preflight)) => format!(
            "ok: {} {} {} {} {} {:?}",
            preflight.revision_id,
            preflight.proposal_id,
            preflight.current_decision_id,
            preflight.envelope_digest,
            preflight.envelope,
            preflight.membership
        ),
    }
}

/// Memo-less and memoized preflights for every roster revision, side by side.
fn both_ways(f: &Fixture) -> (Vec<String>, Vec<String>) {
    let project = f.project().to_owned();
    f.db.with_read_transaction(|tx| {
        let authority = load_live_project_scope_authority(
            tx,
            &project,
            &format!("project:scope-authority:{project}"),
        )?;
        let roster = read_eligibility_source(tx, &project)?;
        let plain = roster
            .revisions
            .iter()
            .map(|revision| {
                describe(preflight_build_candidate(
                    tx, &project, revision, &authority,
                ))
            })
            .collect::<Vec<_>>();
        let mut memo = RunProofMemo::default();
        let memoized = roster
            .revisions
            .iter()
            .map(|revision| {
                describe(preflight_build_candidate_with_memo(
                    tx, &project, revision, &authority, &mut memo,
                ))
            })
            .collect::<Vec<_>>();
        Ok((plain, memoized))
    })
    .expect("preflight both ways")
}

/// The membership read itself (before `preflight` folds every unavailable
/// status into one reason), memo-less and memoized with one shared memo.
/// Unavailable keeps its status and every issue code and binding.
fn membership_both_ways(f: &Fixture) -> (Vec<String>, Vec<String>) {
    fn describe(read: anyhow::Result<MaterialMembershipRead>) -> String {
        match read {
            Err(error) => format!("error: {error}"),
            Ok(MaterialMembershipRead::Unavailable { status, issues }) => {
                format!("unavailable: {status:?} {issues:?}")
            }
            Ok(MaterialMembershipRead::Complete(membership)) => {
                format!("complete: {membership:?}")
            }
        }
    }
    let project = f.project().to_owned();
    f.db.with_read_transaction(|tx| {
        let roster = read_eligibility_source(tx, &project)?;
        let plain = roster
            .revisions
            .iter()
            .map(|revision| describe(read_revision_material_membership(tx, &project, revision)))
            .collect::<Vec<_>>();
        let mut memo = RunProofMemo::default();
        let memoized = roster
            .revisions
            .iter()
            .map(|revision| {
                describe(read_revision_material_membership_with_memo(
                    tx, &project, revision, &mut memo,
                ))
            })
            .collect::<Vec<_>>();
        Ok((plain, memoized))
    })
    .expect("membership both ways")
}

fn tamper(f: &Fixture, sql: &str) {
    f.db.with_conn(|conn| {
        let changed = conn.execute(sql, [])?;
        anyhow::ensure!(changed > 0, "tamper must change a row: {sql}");
        Ok(())
    })
    .expect("private fixture tamper");
}

#[test]
fn memoized_preflight_matches_the_memo_less_preflight_for_every_candidate() {
    let f = Fixture::new();
    let (plain, memoized) = both_ways(&f);
    assert!(
        plain.iter().filter(|line| line.starts_with("ok: ")).count() >= 2,
        "the fixture must hold several verified Roots of one Run: {plain:?}"
    );
    assert_eq!(plain, memoized);
}

#[test]
fn memoized_preflight_keeps_every_failure_class_of_the_memo_less_preflight() {
    // Each tamper breaks a different Run-level proof for all Roots of the Run,
    // and `issue` names the membership issue code that proves the tamper
    // reached the branch the memo caches (not an earlier lineage/Root check).
    for (name, sql, issue) in [
        (
            "receipt hydration (model binding rows)",
            "DELETE FROM narrative_extraction_stage_model_bindings",
            "receipt-hydration-invalid",
        ),
        (
            "artifact digest",
            "UPDATE narrative_extraction_artifacts SET payload_digest='sha256:tampered' \
             WHERE artifact_kind='source.window-plan@1'",
            "artifact-digest-mismatch",
        ),
        (
            "missing inline artifact binding",
            "UPDATE narrative_extraction_artifacts SET payload_digest=NULL \
             WHERE artifact_kind='chronicle.event-clusters@1'",
            "artifact-inline-binding-missing",
        ),
        (
            "snapshot authority (snapshot task output)",
            "UPDATE narrative_extraction_tasks SET output_json='{}' \
             WHERE task_kind='source.snapshot@1'",
            "snapshot-authority-invalid",
        ),
        (
            "accepted artifact (window plan row removed)",
            "DELETE FROM narrative_extraction_artifacts \
             WHERE artifact_kind='source.window-plan@1'",
            "recipe-input-binding-invalid",
        ),
    ] {
        let f = Fixture::new();
        tamper(&f, sql);
        let (plain, memoized) = both_ways(&f);
        assert!(
            plain.iter().all(|line| !line.starts_with("ok: ")),
            "{name}: the tamper must make the Run unavailable: {plain:?}"
        );
        assert_eq!(plain, memoized, "{name}: preflight");
        let (plain, memoized) = membership_both_ways(&f);
        assert!(
            plain.iter().any(|line| line.contains(issue)),
            "{name}: the tamper must reach `{issue}`: {plain:?}"
        );
        assert_eq!(plain, memoized, "{name}: membership status and issues");
    }
}

#[test]
fn a_prepare_verifies_each_run_once_however_many_roots_it_has() {
    let f = Fixture::new();
    let project = f.project().to_owned();
    let run_id = f.manifest["runId"].as_str().expect("run").to_owned();
    let roots = f.manifest["rootRevisionIds"]
        .as_array()
        .expect("roots")
        .len();
    assert!(roots >= 2, "one Run with several Roots");
    let receipts: usize =
        f.db.with_read_transaction(|tx| {
            Ok(tx.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_stage_receipts WHERE run_id=?1",
                [&run_id],
                |row| row.get::<_, i64>(0),
            )? as usize)
        })
        .expect("receipt count");
    assert!(receipts > 0);

    reset_counters();
    let candidates =
        f.db.with_read_transaction(|tx| {
            Ok(super::build::read_snapshot(tx, &project)?
                .expect("snapshot")
                .candidates
                .len())
        })
        .expect("memoized prepare");
    assert!(candidates >= 2);
    assert_eq!(
        counter(&RECEIPT_HYDRATION_COUNT),
        1,
        "one Run, one hydration"
    );
    assert_eq!(
        counter(&RECEIPT_LIFECYCLE_BINDING_COUNT),
        receipts,
        "each receipt's lifecycle/audit evidence is checked once"
    );

    // Without the memo every Root repeats the whole Run's verification.
    reset_counters();
    f.db.with_read_transaction(|tx| {
        let authority = load_live_project_scope_authority(
            tx,
            &project,
            &format!("project:scope-authority:{project}"),
        )?;
        for revision in read_eligibility_source(tx, &project)?.revisions {
            let _ = preflight_build_candidate(tx, &project, &revision, &authority)?;
        }
        Ok(())
    })
    .expect("memo-less prepare");
    assert!(counter(&RECEIPT_HYDRATION_COUNT) >= roots);
    assert!(counter(&RECEIPT_LIFECYCLE_BINDING_COUNT) >= roots * receipts);
}

#[test]
fn run_proofs_do_not_survive_into_the_next_prepare() {
    let f = Fixture::new();
    let project = f.project().to_owned();
    let prepare = || {
        reset_counters();
        let candidates =
            f.db.with_read_transaction(|tx| {
                Ok(super::build::read_snapshot(tx, &project)?
                    .expect("snapshot")
                    .candidates
                    .len())
            })
            .expect("prepare");
        (candidates, counter(&RECEIPT_HYDRATION_COUNT))
    };
    let (before, hydrations) = prepare();
    assert!(before >= 2 && hydrations == 1);
    // An identical second prepare re-verifies the Run: nothing is carried over.
    assert_eq!(prepare(), (before, 1));
    // And a durable change between two prepares is seen by the second one.
    tamper(&f, "DELETE FROM narrative_extraction_stage_model_bindings");
    let (after, hydrations) = prepare();
    assert_eq!((after, hydrations), (0, 1));
}
