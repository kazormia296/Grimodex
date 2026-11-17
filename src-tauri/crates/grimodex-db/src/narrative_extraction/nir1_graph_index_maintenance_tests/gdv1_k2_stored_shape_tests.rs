//! GDV/1 K-2 (b): the stored shape of a Verify outcome that the build before
//! GDV/1 sealed (no `consumersExcludedNotCurrent` field). This file needs the
//! new field, so it is a new-build test; the cross-build byte comparison is in
//! `gdv1_k2_byte_compat_tests.rs`.

use super::gdv1_k2_byte_compat_tests::{latest_completed_verify, open_snapshot, SNAPSHOTS};
use super::*;
use crate::narrative_extraction::restore_rebuild::{DependencyGraphVerifyReport, VerifyExcludedConsumer};

/// A stored pre-GDV/1 report has no excluded-consumer field. It deserializes
/// (the field defaults to empty) and serializes back to the very bytes that
/// were stored, so the version `"9"` outcome stays valid and unchanged.
#[test]
fn a_report_stored_before_gdv1_reads_and_writes_back_unchanged() -> Result<()> {
    let _serial = serial();
    for snapshot in &SNAPSHOTS {
        let (_directory, db) = open_snapshot(snapshot)?;
        let (_, _, outcome) = latest_completed_verify(&db, snapshot.project)?;
        let stored: serde_json::Value = serde_json::from_str(&outcome)?;
        assert!(
            !outcome.contains("consumersExcludedNotCurrent"),
            "{}: a pre-GDV/1 outcome has no excluded-consumer field",
            snapshot.name
        );
        let report: DependencyGraphVerifyReport = serde_json::from_value(stored["report"].clone())?;
        assert!(report.consumers_excluded_not_current.is_empty(), "{}", snapshot.name);
        assert!(report.is_clean(), "{}", snapshot.name);
        assert_eq!(
            serde_json::to_string(&serde_json::to_value(&report)?)?,
            serde_json::to_string(&stored["report"])?,
            "{}: written back byte for byte",
            snapshot.name
        );
    }
    Ok(())
}

/// The positive control: a report that does exclude a consumer writes the field
/// (so the absence above is the pre-GDV/1 shape, not a field that is never
/// written), and reads it back.
#[test]
fn a_report_that_excludes_a_consumer_writes_the_field_and_reads_it_back() -> Result<()> {
    let _serial = serial();
    let (_directory, db) = open_snapshot(&SNAPSHOTS[1])?;
    let mut report = db.with_conn_mut(|conn| {
        crate::narrative_extraction::restore_rebuild::verify_narrative_dependency_graph_for_project(
            conn, PROJECT,
        )
    })?;
    assert!(report.consumers_excluded_not_current.is_empty());
    let before = serde_json::to_value(&report)?;
    assert!(before.get("consumersExcludedNotCurrent").is_none());
    report.consumers_excluded_not_current.push(VerifyExcludedConsumer {
        consumer_kind: "semantic-index".to_string(),
        consumer_key: INDEX_KEY.to_string(),
        edge_count: 4,
    });
    let after = serde_json::to_value(&report)?;
    assert_eq!(
        after["consumersExcludedNotCurrent"],
        json!([{"consumerKind": "semantic-index", "consumerKey": INDEX_KEY, "edgeCount": 4}])
    );
    let back: DependencyGraphVerifyReport = serde_json::from_value(after)?;
    assert_eq!(back, report);
    Ok(())
}

// ---------------------------------------------------------------------------
// T-9 (ii): a Verify that failed for capacity before GDV/1
// ---------------------------------------------------------------------------

const FAILED_VERIFY_DB: &[u8] = include_bytes!("../../../tests/support/gdv1-k2-failed-verify.db.gz");

/// `gdv1-k2-failed-verify.db.gz` was made by the build before GDV/1 (see
/// `gdv1_k2_byte_compat_tests.rs`): a dirty Graph binding over the candidate
/// bound (2,065), B refusing it, and the Verify that the B-ROUTE seam wakes
/// failed for capacity, with its one `narrative-maintenance-failure` Finding.
/// Opening it with this build, the Verify does not come back by itself within
/// the same Semantic Epoch (contract section 5, "既に止まっている project"):
/// main's discovery keeps handing out `Work(Verify)`, the cycle does not create
/// a new Run, and the Run and Finding counts stay the same. GDV/1 adds no
/// automatic recovery for this form.
#[test]
fn a_verify_that_failed_for_capacity_before_gdv1_does_not_come_back_by_itself() -> Result<()> {
    use crate::narrative_extraction::maintenance_runtime::{
        discover_maintenance_project_for_main, effective_maintenance_coordinates,
        MaintenanceProjectDiscovery,
    };
    let _serial = serial();
    let snapshot = super::gdv1_k2_byte_compat_tests::Snapshot {
        name: "failed-verify",
        compressed: FAILED_VERIFY_DB,
        project: PROJECT,
    };
    let (_directory, db) = open_snapshot(&snapshot)?;
    let ledger = run_ledger(&db)?;
    let findings = finding_keys(&db)?;
    assert_eq!(
        ledger.last(),
        Some(&("dependency-verify".to_string(), "failed".to_string())),
        "{ledger:?}"
    );
    assert_eq!(findings.len(), 1, "{findings:?}");
    assert!(findings[0].starts_with("narrative-maintenance-failure:dependency-verify:"));

    let coordinates = effective_maintenance_coordinates(None)?;
    for wake in 0..6 {
        // The product path (no seam, no token): main's discovery hands out the
        // Verify of the same Semantic Epoch every time, and does not fail
        // (GDV/1: the dirty binding no longer ends the uncontrolled read).
        let discovery = discover_maintenance_project_for_main(
            &db,
            PROJECT,
            "workspace-opened",
            Some(&coordinates),
            None,
        )?;
        let MaintenanceProjectDiscovery::Work(work) = discovery else {
            panic!("wake#{wake}: expected Work(Verify), got {discovery:?}");
        };
        assert_eq!(work.run_kind, AutomaticRunKind::Verify, "wake#{wake}");
        let request = MaintenanceCycleRequest {
            work: vec![MaintenanceWorkRequest {
                project_id: work.project_id.clone(),
                run_kind: work.run_kind,
                work_key: work.work_key.clone(),
                semantic_epoch_id: work.semantic_epoch_id.clone(),
                reasons: work.reasons.clone(),
            }],
            wake_project_ids: Vec::new(),
            delivery_sequence: None,
            delivery_fingerprint: None,
            workspace_binding: None,
        };
        let recorder = Recorder::default();
        let result = run_cycle_on(&db, None, &request, None, &recorder)?;
        assert_eq!(result.status, MaintenanceCycleStatus::Accepted, "wake#{wake}");
        // No new Run, no new Finding: the form is left as it was.
        assert_eq!(run_ledger(&db)?, ledger, "wake#{wake}");
        assert_eq!(finding_keys(&db)?, findings, "wake#{wake}");
    }
    Ok(())
}
