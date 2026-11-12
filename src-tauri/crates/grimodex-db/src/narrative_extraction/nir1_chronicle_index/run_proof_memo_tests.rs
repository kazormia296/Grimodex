//! The per-prepare Run proof memo (DR-IRB-4) never changes what a prepare
//! decides: it only skips re-verifying a Run that the same read snapshot has
//! already verified for another Root.
use std::{cell::Cell, io::Read, path::PathBuf};

use flate2::read::GzDecoder;
use serde_json::Value;

use super::{source::read_eligibility_source, test_support::Fixture};
use crate::{
    narrative_extraction::{
        material_membership::{
            read_revision_material_membership, read_revision_material_membership_with_memo,
            MaterialMembershipRead,
        },
        material_membership_root::{read_root_material_with_memo, RunProofMemo},
        project_scope_authority::load_live_project_scope_authority,
        retrieval_admission::build::{
            preflight_build_candidate, preflight_build_candidate_with_memo,
        },
        stage_provenance::{RECEIPT_HYDRATION_COUNT, RECEIPT_LIFECYCLE_BINDING_COUNT},
    },
    Database,
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
            "ok: {} {} {} {} {} {:?} {:?}",
            preflight.revision_id,
            preflight.proposal_id,
            preflight.current_decision_id,
            preflight.envelope_digest,
            preflight.envelope,
            preflight.membership,
            preflight.material_source_keys
        ),
    }
}

/// Memo-less and memoized preflights for every roster revision, side by side.
fn both_ways(db: &Database, project: &str) -> (Vec<String>, Vec<String>) {
    let project = project.to_owned();
    db.with_read_transaction(|tx| {
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
fn membership_both_ways(db: &Database, project: &str) -> (Vec<String>, Vec<String>) {
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
    let project = project.to_owned();
    db.with_read_transaction(|tx| {
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
    tamper_db(&f.db, sql);
}

/// The envelope columns are guarded by immutability triggers; the private
/// copy drops it so the test can break exactly one Root's envelope.
fn tamper_envelope(db: &Database, sql: &str) {
    db.with_conn(|conn| {
        conn.execute_batch(
            "DROP TRIGGER narrative_revision_envelope_immutable_update;
             DROP TRIGGER narrative_proposal_revisions_v2_immutable_update_guard;",
        )?;
        Ok(())
    })
    .expect("private copy: drop envelope trigger");
    tamper_db(db, sql);
}

fn tamper_db(db: &Database, sql: &str) {
    db.with_conn(|conn| {
        let changed = conn.execute(sql, [])?;
        anyhow::ensure!(changed > 0, "tamper must change a row: {sql}");
        Ok(())
    })
    .expect("private fixture tamper");
}

#[test]
fn memoized_preflight_matches_the_memo_less_preflight_for_every_candidate() {
    let f = Fixture::new();
    let (plain, memoized) = both_ways(&f.db, f.project());
    assert!(
        plain.iter().filter(|line| line.starts_with("ok: ")).count() >= 2,
        "the fixture must hold several verified Roots of one Run: {plain:?}"
    );
    assert_eq!(plain, memoized);
}

/// A preflight releases the replay's material rows, request proofs and
/// receipts, but keeps the material source keys in the replay's own order:
/// they feed the one scope preload and each candidate's scope selection.
fn assert_preflight_keeps_the_keys(f: &Fixture, at_least: usize) {
    let project = f.project().to_owned();
    f.db.with_read_transaction(|tx| {
        let authority = load_live_project_scope_authority(
            tx,
            &project,
            &format!("project:scope-authority:{project}"),
        )?;
        let roster = read_eligibility_source(tx, &project)?;
        let mut checked = 0;
        for revision in &roster.revisions {
            let MaterialMembershipRead::Complete(full) =
                read_revision_material_membership(tx, &project, revision)?
            else {
                continue;
            };
            let expected = full
                .materials
                .iter()
                .map(|material| material.source_key.clone())
                .collect::<Vec<_>>();
            let Ok(preflight) = preflight_build_candidate(tx, &project, revision, &authority)?
            else {
                continue;
            };
            assert!(!expected.is_empty());
            assert_eq!(preflight.material_source_keys, expected);
            assert!(preflight.membership.materials.is_empty());
            assert!(preflight.membership.replayed_requests.is_empty());
            assert!(preflight.membership.verified_receipts.is_empty());
            assert_eq!(preflight.membership.run_id, full.run_id);
            assert_eq!(preflight.membership.material_basis, full.material_basis);
            checked += 1;
        }
        assert!(checked >= at_least, "verified Roots: {checked}");
        Ok(())
    })
    .expect("preflight keys");
}

#[test]
fn a_preflight_keeps_the_material_source_keys_of_the_full_replay_in_order() {
    assert_preflight_keeps_the_keys(&Fixture::new(), 2);
}

#[test]
fn a_preflight_keeps_the_keys_of_every_window_of_a_three_window_replay_in_order() {
    let f = Fixture::multi_window();
    // The folder Run's crossing proposal is refused by its disclosure
    // (`EvidenceMismatch`) and has no preflight.
    assert_preflight_keeps_the_keys(&f, 3);
    // The material of a three-window Run spans several Scenes: the keys are
    // not one Scene's, so an order change would be visible.
    f.db.with_read_transaction(|tx| {
        let roster = read_eligibility_source(tx, f.project())?;
        let longest = roster
            .revisions
            .iter()
            .filter_map(|revision| {
                match read_revision_material_membership(tx, f.project(), revision).ok()? {
                    MaterialMembershipRead::Complete(m) => Some(m.materials.len()),
                    _ => None,
                }
            })
            .max()
            .unwrap_or(0);
        assert!(longest >= 4, "a replay with several windows: {longest}");
        Ok(())
    })
    .expect("longest replay");
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
        let (plain, memoized) = both_ways(&f.db, f.project());
        assert!(
            plain.iter().all(|line| !line.starts_with("ok: ")),
            "{name}: the tamper must make the Run unavailable: {plain:?}"
        );
        assert_eq!(plain, memoized, "{name}: preflight");
        let (plain, memoized) = membership_both_ways(&f.db, f.project());
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
    // A failed hydration is never cached: every Root of the Run repeats it, as
    // it does without the memo.
    assert_eq!((after, hydrations), (0, 2));
}

/// The cold database of two approved children, each in its own Run (and the
/// same project): the smallest fixture where one Run can be intact while the
/// other is broken inside one read transaction.
struct TwoRuns {
    db: Database,
    path: PathBuf,
    manifest: Value,
}

impl TwoRuns {
    fn new() -> Self {
        let mut bytes = Vec::new();
        GzDecoder::new(
            include_bytes!("../../../tests/support/nir1-two-window-cold.db.gz").as_slice(),
        )
        .read_to_end(&mut bytes)
        .expect("two-window cold fixture");
        let path = std::env::temp_dir().join(format!(
            "nir1-run-memo-two-runs-{}.db",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, bytes).expect("private copy");
        let db = Database::new(&path).expect("open private copy");
        db.migrate().expect("migrate private copy");
        let manifest = serde_json::from_str(include_str!(
            "../../../tests/support/nir1-two-window-cold.json"
        ))
        .expect("provenance");
        Self { db, path, manifest }
    }

    fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }

    fn child(&self, index: usize, field: &str) -> String {
        self.manifest["normalApprovedChildren"][index][field]
            .as_str()
            .expect(field)
            .to_owned()
    }

    /// The second Root of Run B (it has no approved child of its own).
    fn extra_run_b_root(&self) -> String {
        let run_b = self.child(1, "runId");
        self.db
            .with_read_transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT r.id FROM narrative_proposal_revisions r
                     JOIN narrative_proposals p ON p.id = r.proposal_id
                     JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                     WHERE s.run_id = ?1 AND r.id <> ?2
                       AND NOT EXISTS (SELECT 1 FROM narrative_proposal_revisions c
                                        WHERE c.proposal_id = r.proposal_id AND c.id <> r.id)",
                    [&run_b, &self.child(1, "rootRevisionId")],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .expect("second root of Run B")
    }

    fn roster(&self) -> Vec<String> {
        self.db
            .with_read_transaction(|tx| Ok(read_eligibility_source(tx, self.project())?.revisions))
            .expect("roster")
    }
}

impl Drop for TwoRuns {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum MemoUse {
    /// A new memo for every read: the memo-less reference.
    Fresh,
    /// One memo for the whole sequence.
    Shared,
    /// One memo, but every Run is dropped after each read (the worst
    /// possible miscount).
    ReleaseEachRead,
}

/// Every field of the Root reads, in the given order, as text.
fn root_reads(
    db: &Database,
    project: &str,
    order: &[(&str, &str)],
    memo_use: MemoUse,
) -> Vec<String> {
    db.with_read_transaction(|tx| {
        let mut shared = RunProofMemo::default();
        Ok(order
            .iter()
            .map(|(root, run)| {
                let read = match memo_use {
                    MemoUse::Fresh => read_root_material_with_memo(
                        tx,
                        project,
                        root,
                        &mut RunProofMemo::default(),
                    ),
                    MemoUse::Shared | MemoUse::ReleaseEachRead => {
                        read_root_material_with_memo(tx, project, root, &mut shared)
                    }
                };
                if memo_use == MemoUse::ReleaseEachRead {
                    shared.release_run(project, run);
                }
                match read {
                    Ok(read) => format!("{read:?}"),
                    Err(error) => format!("error: {error}"),
                }
            })
            .collect())
    })
    .expect("root reads")
}

const RUN_B_TAMPERS: [(&str, &str, &str); 6] = [
    (
        "receipt hydration",
        "DELETE FROM narrative_extraction_stage_model_bindings WHERE run_id='{RUN}'",
        "receipt-hydration-invalid",
    ),
    (
        "artifact digest",
        "UPDATE narrative_extraction_artifacts SET payload_digest='sha256:tampered' \
         WHERE run_id='{RUN}' AND artifact_kind='source.window-plan@1'",
        "artifact-digest-mismatch",
    ),
    (
        "artifact json invalid (the scan aborts)",
        "UPDATE narrative_extraction_artifacts SET payload_json='{' \
         WHERE run_id='{RUN}' AND artifact_kind='source.window-plan@1'",
        "artifact-json-invalid",
    ),
    (
        "missing inline artifact binding",
        "UPDATE narrative_extraction_artifacts SET payload_digest=NULL \
         WHERE run_id='{RUN}' AND artifact_kind='chronicle.event-clusters@1'",
        "artifact-inline-binding-missing",
    ),
    (
        "snapshot authority",
        "UPDATE narrative_extraction_tasks SET output_json='{}' \
         WHERE run_id='{RUN}' AND task_kind='source.snapshot@1'",
        "snapshot-authority-invalid",
    ),
    (
        "accepted artifact (window plan row removed)",
        "DELETE FROM narrative_extraction_artifacts \
         WHERE run_id='{RUN}' AND artifact_kind='source.window-plan@1'",
        "recipe-input-binding-invalid",
    ),
];

#[test]
fn a_broken_run_never_changes_an_intact_run_of_the_same_prepare() {
    for (name, sql, issue) in RUN_B_TAMPERS {
        let f = TwoRuns::new();
        let project = f.project().to_owned();
        let (run_a, run_b) = (f.child(0, "runId"), f.child(1, "runId"));
        let (revision_a, revision_b) = (f.child(0, "revisionId"), f.child(1, "revisionId"));
        let roster = f.roster();
        let position = |revision: &str| {
            roster
                .iter()
                .position(|candidate| candidate == revision)
                .expect("approved child in the roster")
        };
        let (a, b) = (position(&revision_a), position(&revision_b));
        assert_ne!(a, b);

        let (baseline, _) = both_ways(&f.db, &project);
        let (baseline_membership, _) = membership_both_ways(&f.db, &project);
        assert!(
            baseline[a].starts_with("ok: ") && baseline[b].starts_with("ok: "),
            "{name}: both Runs start intact: {baseline:?}"
        );
        tamper_db(&f.db, &sql.replace("{RUN}", &run_b));
        assert_ne!(run_a, run_b);

        let (plain, memoized) = both_ways(&f.db, &project);
        assert_eq!(plain, memoized, "{name}: preflight");
        assert_eq!(plain[a], baseline[a], "{name}: Run A is unchanged");
        assert!(!plain[b].starts_with("ok: "), "{name}: Run B is broken");
        let (plain, memoized) = membership_both_ways(&f.db, &project);
        assert_eq!(plain, memoized, "{name}: membership");
        assert_eq!(plain[a], baseline_membership[a], "{name}: Run A membership");
        assert!(
            plain[b].contains(issue),
            "{name}: reaches `{issue}`: {plain:?}"
        );
    }
}

#[test]
fn interleaved_roots_of_an_intact_and_a_broken_run_read_the_same_with_or_without_the_memo() {
    for (name, sql, _) in RUN_B_TAMPERS {
        let f = TwoRuns::new();
        let project = f.project().to_owned();
        let (root_a, run_a) = (f.child(0, "rootRevisionId"), f.child(0, "runId"));
        let (root_b, run_b) = (f.child(1, "rootRevisionId"), f.child(1, "runId"));
        let root_b2 = f.extra_run_b_root();
        let a = (root_a.as_str(), run_a.as_str());
        let b = (root_b.as_str(), run_b.as_str());
        let b2 = (root_b2.as_str(), run_b.as_str());
        // Run B has two Roots, interleaved with Run A's one.
        let order = [a, b, b2, a, b2, b, a];

        let intact = root_reads(&f.db, &project, &[a, b2], MemoUse::Fresh);
        assert!(intact[0].contains("status: Complete"), "{intact:?}");
        assert!(
            intact[1].contains("status: Complete"),
            "Run B's second Root reaches the Run-level proofs: {intact:?}"
        );
        tamper_db(&f.db, &sql.replace("{RUN}", &run_b));

        let reference = root_reads(&f.db, &project, &order, MemoUse::Fresh);
        for memo_use in [MemoUse::Shared, MemoUse::ReleaseEachRead] {
            assert_eq!(
                reference,
                root_reads(&f.db, &project, &order, memo_use),
                "{name}: {memo_use:?}"
            );
        }
        for index in [0, 3, 6] {
            assert_eq!(reference[index], intact[0], "{name}: A read {index}");
        }
        for index in [1, 5] {
            assert!(
                !reference[index].contains("status: Complete"),
                "{name}: B read {index}"
            );
        }
    }
}

#[test]
fn a_broken_root_never_changes_another_root_of_the_same_run() {
    // Both Roots of one Run; the broken one is read first, then second.
    for victim in 0..2 {
        for (name, sql, issue) in [
            (
                "envelope json",
                "UPDATE narrative_proposal_revisions SET reconciliation_envelope_json='{' WHERE id='{ROOT}'",
                "envelope-json-invalid",
            ),
            (
                "envelope digest",
                "UPDATE narrative_proposal_revisions SET reconciliation_envelope_digest='sha256:x' WHERE id='{ROOT}'",
                "envelope-digest-mismatch",
            ),
            (
                "envelope removed",
                "UPDATE narrative_proposal_revisions SET reconciliation_envelope_json=NULL WHERE id='{ROOT}'",
                "envelope-unavailable",
            ),
        ] {
            let f = Fixture::new();
            let project = f.project().to_owned();
            let run = f.manifest["runId"].as_str().expect("run").to_owned();
            let roots: Vec<String> = f.manifest["rootRevisionIds"]
                .as_array()
                .expect("roots")
                .iter()
                .map(|root| root.as_str().expect("root").to_owned())
                .collect();
            let order = [
                (roots[0].as_str(), run.as_str()),
                (roots[1].as_str(), run.as_str()),
                (roots[0].as_str(), run.as_str()),
                (roots[1].as_str(), run.as_str()),
            ];
            let intact = root_reads(&f.db, &project, &order, MemoUse::Fresh);
            assert!(intact.iter().all(|read| read.contains("status: Complete")));

            tamper_envelope(&f.db, &sql.replace("{ROOT}", &roots[victim]));
            let reference = root_reads(&f.db, &project, &order, MemoUse::Fresh);
            for memo_use in [MemoUse::Shared, MemoUse::ReleaseEachRead] {
                assert_eq!(
                    reference,
                    root_reads(&f.db, &project, &order, memo_use),
                    "{name} (victim {victim}): {memo_use:?}"
                );
            }
            for (index, read) in reference.iter().enumerate() {
                if index % 2 == victim {
                    assert!(read.contains(issue), "{name}: victim read {index}: {read}");
                } else {
                    assert_eq!(read, &intact[index], "{name}: bystander read {index}");
                }
            }
        }
    }
}

#[test]
fn a_run_is_dropped_when_its_last_roster_revision_is_done() {
    // One Run, two roster revisions.
    let f = Fixture::new();
    let project = f.project().to_owned();
    f.db.with_read_transaction(|tx| {
        let authority = load_live_project_scope_authority(
            tx,
            &project,
            &format!("project:scope-authority:{project}"),
        )?;
        let roster = read_eligibility_source(tx, &project)?.revisions;
        assert_eq!(roster.len(), 2, "two roster revisions of one Run");
        let mut memo = RunProofMemo::default();
        memo.expect_revisions(tx, &project, &roster)?;
        reset_counters();
        preflight_build_candidate_with_memo(tx, &project, &roster[0], &authority, &mut memo)?
            .expect("first candidate");
        assert_eq!(memo.held_runs(), 1);
        memo.finish_revision(&project, &roster[0]);
        assert_eq!(
            memo.held_runs(),
            1,
            "one revision of the Run is still to come"
        );
        preflight_build_candidate_with_memo(tx, &project, &roster[1], &authority, &mut memo)?
            .expect("second candidate");
        memo.finish_revision(&project, &roster[1]);
        assert_eq!(memo.held_runs(), 0, "the last revision releases the Run");
        assert_eq!(counter(&RECEIPT_HYDRATION_COUNT), 1, "verified once");
        Ok(())
    })
    .expect("counted prepare");
}

#[test]
fn runs_are_dropped_one_by_one_and_uncounted_revisions_drop_nothing() {
    // Run A has one roster revision, Run B two (a second Root and a child).
    let f = TwoRuns::new();
    let project = f.project().to_owned();
    let roster = f.roster();
    assert_eq!(roster.len(), 3);
    let (rev_a, rev_b) = (f.child(0, "revisionId"), f.child(1, "revisionId"));
    let rev_b2 = roster
        .iter()
        .find(|revision| **revision != rev_a && **revision != rev_b)
        .expect("Run B's second roster revision")
        .clone();
    f.db.with_read_transaction(|tx| {
        let authority = load_live_project_scope_authority(
            tx,
            &project,
            &format!("project:scope-authority:{project}"),
        )?;
        let read = |memo: &mut RunProofMemo, revision: &str| {
            // Whether the candidate is eligible does not matter here, only
            // that its Run was read.
            let _ = preflight_build_candidate_with_memo(tx, &project, revision, &authority, memo)?;
            anyhow::Ok(())
        };
        let mut memo = RunProofMemo::default();
        memo.expect_revisions(tx, &project, &roster)?;
        read(&mut memo, &rev_b)?;
        memo.finish_revision(&project, &rev_b);
        assert_eq!(memo.held_runs(), 1, "Run B still has a roster revision");
        read(&mut memo, &rev_a)?;
        assert_eq!(memo.held_runs(), 2);
        memo.finish_revision(&project, &rev_a);
        assert_eq!(memo.held_runs(), 1, "Run A's only revision is done");
        read(&mut memo, &rev_b2)?;
        memo.finish_revision(&project, &rev_b2);
        assert_eq!(memo.held_runs(), 0, "Run B's last revision is done");

        // A revision the memo was not told about, and a revision it does not
        // know at all, release nothing.
        let mut memo = RunProofMemo::default();
        memo.expect_revisions(tx, &project, std::slice::from_ref(&rev_a))?;
        read(&mut memo, &rev_b)?;
        memo.finish_revision(&project, &rev_b);
        memo.finish_revision(&project, "unknown-revision");
        assert_eq!(memo.held_runs(), 1);
        // A memo that was never told the roster keeps everything.
        let mut memo = RunProofMemo::default();
        read(&mut memo, &rev_a)?;
        memo.finish_revision(&project, &rev_a);
        assert_eq!(memo.held_runs(), 1);
        Ok(())
    })
    .expect("counted prepare");
}

#[test]
fn a_wrong_count_only_repeats_work() {
    // The count says the Run has one revision, but it has two: the Run is
    // dropped after the first and verified again for the second. Results are
    // the same; only the verification repeats.
    let f = Fixture::new();
    let project = f.project().to_owned();
    f.db.with_read_transaction(|tx| {
        let authority = load_live_project_scope_authority(
            tx,
            &project,
            &format!("project:scope-authority:{project}"),
        )?;
        let roster = read_eligibility_source(tx, &project)?.revisions;
        let plain = roster
            .iter()
            .map(|revision| {
                describe(preflight_build_candidate(
                    tx, &project, revision, &authority,
                ))
            })
            .collect::<Vec<_>>();
        let mut memo = RunProofMemo::default();
        memo.expect_revisions(tx, &project, &roster[..1])?;
        reset_counters();
        let counted = roster
            .iter()
            .map(|revision| {
                let result = preflight_build_candidate_with_memo(
                    tx, &project, revision, &authority, &mut memo,
                );
                memo.finish_revision(&project, revision);
                describe(result)
            })
            .collect::<Vec<_>>();
        assert_eq!(plain, counted);
        assert_eq!(
            counter(&RECEIPT_HYDRATION_COUNT),
            2,
            "verified again, not wrong"
        );
        Ok(())
    })
    .expect("miscounted prepare");
}
