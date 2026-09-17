#![cfg(feature = "nir1-material-diagnostics")]

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "grimodex-nir1-capacity-binary-{label}-{}",
        uuid::Uuid::new_v4()
    ))
}

fn copy_database_state(source: &Path, destination: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut source_path = source.as_os_str().to_owned();
        source_path.push(suffix);
        let source_path = Path::new(&source_path);
        let mut destination_path = destination.as_os_str().to_owned();
        destination_path.push(suffix);
        let destination_path = Path::new(&destination_path);
        match fs::copy(source_path, destination_path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && suffix != "" => {}
            Err(error) => panic!(
                "copy {} to {}: {error}",
                source_path.display(),
                destination_path.display()
            ),
        }
    }
}

fn run_capacity(args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_nir1-material-capacity"))
        .args(args)
        .output()
        .expect("run nir1-material-capacity binary");
    assert!(
        output.status.success(),
        "capacity binary failed for {args:?}: {}\n{}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    serde_json::from_slice(&output.stdout).expect("capacity binary emitted JSON")
}

fn run_capacity_probe(probe: &Path, args: &[String]) -> Value {
    let output = Command::new("node")
        .arg(probe)
        .args(args)
        .output()
        .expect("run nir1 material capacity probe");
    assert!(
        output.status.success(),
        "capacity probe failed for {args:?}: {}\n{}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    serde_json::from_slice(&output.stdout).expect("capacity probe emitted JSON")
}

#[test]
fn real_binary_report_heavy_crosses_build_coverage_and_restore() {
    let manifest = temp_path("manifest");
    let source = temp_path("source");
    let manifest_text = r#"{
        "schemaVersion": "nir1-capacity/1",
        "diagnosticOnly": true,
        "fixtures": [
            {"id": "D2064/report-heavy", "ineligibleCandidates": 5}
        ]
    }"#;
    fs::write(&manifest, manifest_text).expect("write report-heavy manifest");
    let mut children = Vec::new();

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let fixture = run_capacity(&[
            "fixture",
            manifest.to_str().expect("manifest path"),
            "D2064/report-heavy",
            source.to_str().expect("source path"),
        ]);
        assert_eq!(fixture["observed"]["counts"]["reportRecords"], 1);

        for mode in ["full-build", "coverage", "restore"] {
            let child = temp_path(mode);
            copy_database_state(&source, &child);
            children.push(child.clone());
            let observation = run_capacity(&[
                child.to_str().expect("child path"),
                "D2064/report-heavy",
                "nir1-capacity-fixture-project",
                "--mode",
                mode,
            ]);
            assert_eq!(observation["fixtureId"], "D2064/report-heavy");
            assert_eq!(observation["mode"], mode);
            assert_eq!(observation["status"], "measured");
            assert_eq!(observation["supportedCapacityClaim"], false);
            assert_eq!(observation["fixtureShape"]["reportRecords"], 1);
            assert_eq!(observation["modeOutcome"]["success"], true);
            assert_eq!(observation["modeOutcome"]["requiredSuccess"], true);
            assert!(
                observation["graphLifecycle"]["publishTransactionMs"].is_number(),
                "{mode} must retain publish transaction elapsed time"
            );
            assert!(
                observation["occupancy"]["publishTransactionMs"].is_number(),
                "{mode} must expose publish transaction occupancy"
            );
            assert!(
                observation["modeOutcome"]["operationReportRecords"]
                    .as_u64()
                    .is_some_and(|records| records >= 1),
                "{mode} must report operation-produced Verify records"
            );
            if mode == "restore" {
                assert!(
                    observation["graphLifecycle"]["restoreImageIdentity"]
                        .as_str()
                        .is_some_and(|identity| identity.starts_with("restore-image-sha256:")),
                    "Restore must report its restored image identity"
                );
                assert!(observation["graphLifecycle"]["restoreWorkspaceIdentity"].is_string());
                assert!(observation["graphLifecycle"]["restoreEpoch"].is_string());
                assert_eq!(
                    observation["graphLifecycle"]["restoreMaintenanceValidated"],
                    true
                );
            }
            let _ = fs::remove_file(&child);
            let _ = fs::remove_file(format!("{}-wal", child.display()));
            let _ = fs::remove_file(format!("{}-shm", child.display()));
        }
    }));

    let _ = fs::remove_file(&manifest);
    let _ = fs::remove_file(&source);
    let _ = fs::remove_file(format!("{}-wal", source.display()));
    let _ = fs::remove_file(format!("{}-shm", source.display()));
    for child in children {
        let _ = fs::remove_file(&child);
        let _ = fs::remove_file(format!("{}-wal", child.display()));
        let _ = fs::remove_file(format!("{}-shm", child.display()));
    }
    if let Err(payload) = result {
        std::panic::resume_unwind(payload);
    }
}

#[test]
fn real_binary_qualified_roster_restore_preserves_old_state_and_publishes_fresh_empty_graph() {
    let manifest = temp_path("manifest-qualified-roster");
    let source = temp_path("source-qualified-roster");
    let manifest_text = r#"{
        "schemaVersion": "nir1-capacity/1",
        "diagnosticOnly": true,
        "fixtures": [
            {"id": "Q513/R3/D0", "qualifiedMaterials": 513, "qualifiedRevisions": 3}
        ]
    }"#;
    fs::write(&manifest, manifest_text).expect("write qualified-roster manifest");
    let child = temp_path("qualified-roster-restore");

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let fixture = run_capacity(&[
            "fixture",
            manifest.to_str().expect("manifest path"),
            "Q513/R3/D0",
            source.to_str().expect("source path"),
        ]);
        assert_eq!(
            fixture["observed"]["counts"]["qualifiedMaterialRecords"],
            513
        );
        assert_eq!(fixture["observed"]["counts"]["qualifiedRevisions"], 3);

        copy_database_state(&source, &child);
        let observation = run_capacity(&[
            child.to_str().expect("child path"),
            "Q513/R3/D0",
            "nir1-capacity-fixture-project",
            "--mode",
            "restore",
        ]);
        assert_eq!(observation["fixtureId"], "Q513/R3/D0");
        assert_eq!(observation["mode"], "restore");
        assert_eq!(observation["status"], "measured");
        assert_eq!(observation["counts"]["qualifiedMaterialRecords"], 513);
        assert_eq!(observation["counts"]["qualifiedRevisions"], 3);
        assert_eq!(observation["fixtureShape"]["rosterRecords"], 513);
        assert_eq!(observation["counts"]["rosterRecords"], 0);
        assert_eq!(observation["modeOutcome"]["success"], true);
        assert_eq!(observation["modeOutcome"]["requiredSuccess"], true);
        assert!(
            observation["graphLifecycle"]["publishTransactionMs"].is_number(),
            "Restore must retain publish transaction elapsed time"
        );
        assert!(
            observation["occupancy"]["publishTransactionMs"].is_number(),
            "Restore must expose publish transaction occupancy"
        );
        assert_eq!(
            observation["graphLifecycle"]["restoreMaintenanceValidated"],
            true
        );
        assert!(observation["graphLifecycle"]["restoreImageIdentity"]
            .as_str()
            .is_some_and(|identity| identity.starts_with("restore-image-sha256:")));
        assert!(observation["graphLifecycle"]["restoreEpoch"].is_string());
        let proof = &observation["graphLifecycle"]["restoreProof"];
        for field in [
            "bindingPersisted",
            "generationPreserved",
            "sourceDigestPreserved",
            "d1BindingPreserved",
            "edgeBindingPreserved",
            "dirtyCacheFlagCleared",
            "incompleteRejected",
            "coldReopenRejected",
            "oldA2RevisionsInvalidated",
            "oldRevisionTuplesPreserved",
            "oldDecisionsPreserved",
            "oldRunEpochsPreserved",
            "canonicalRebuildOldA2RevisionsInvalidated",
            "canonicalRebuildOldRevisionTuplesPreserved",
            "canonicalRebuildOldDecisionsPreserved",
            "canonicalRebuildOldRunEpochsPreserved",
            "staleSnapshotPublishRejected",
            "staleSnapshotGenerationUnchanged",
            "postRestoreComplete",
            "postRestoreVerifySucceeded",
            "postRestoreColdReopenSucceeded",
        ] {
            assert_eq!(proof[field], true, "Restore proof field {field}");
        }
        assert_eq!(proof["eligibleRecordsAfterRestore"], 0);
        assert_eq!(proof["postRestoreQualifiedRevisions"], 0);
        assert_eq!(proof["postRestoreRosterRecords"], 0);
        assert_eq!(
            observation["graphLifecycle"]["coldReopened"], true,
            "post-restore cold reopen must use a fresh Database"
        );
    }));

    let _ = fs::remove_file(&manifest);
    for path in [&source, &child] {
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(format!("{}-wal", path.display()));
        let _ = fs::remove_file(format!("{}-shm", path.display()));
    }
    if let Err(payload) = result {
        std::panic::resume_unwind(payload);
    }
}

#[test]
fn real_binary_qualified_restore_passes_through_probe_orchestration() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("resolve Grimodex repository root");
    let canonical_manifest = root.join("evals/nir1-capacity/manifest.v1.json");
    let canonical_schema = root.join("evals/nir1-capacity/schema.v1.json");
    let probe_root = temp_path("qualified-roster-probe");
    let manifest = probe_root.join("manifest.v1.json");
    let schema = probe_root.join("schema.v1.json");
    let fixture_directory = probe_root.join("fixtures");
    let output_directory = probe_root.join("output");
    let probe = probe_root.join("probe.mjs");
    let node_modules = probe_root.join("node_modules");
    fs::create_dir_all(&fixture_directory).expect("create probe fixture directory");
    fs::create_dir_all(&output_directory).expect("create probe output directory");

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        fs::copy(
            root.join("scripts/nir1-material-capacity-probe.mjs"),
            &probe,
        )
        .expect("copy capacity probe");
        let source_node_modules = root
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .map(|parent| parent.join("Grimodex/node_modules"))
            .filter(|candidate| candidate.is_dir())
            .or_else(|| {
                root.join("node_modules")
                    .is_dir()
                    .then(|| root.join("node_modules"))
            })
            .expect("find Node dependencies for capacity probe");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&source_node_modules, &node_modules)
            .expect("link temporary Node dependencies for capacity probe");
        #[cfg(not(unix))]
        fs::copy(&source_node_modules, &node_modules).expect("copy Node dependencies");
        let mut manifest_value: Value = serde_json::from_str(
            &fs::read_to_string(&canonical_manifest).expect("read capacity manifest"),
        )
        .expect("parse capacity manifest");
        let restore = manifest_value["diagnosticModes"]
            .as_array_mut()
            .expect("diagnostic modes array")
            .iter_mut()
            .find(|mode| mode["id"] == "restore")
            .expect("restore diagnostic mode");
        restore["fixtures"]
            .as_array_mut()
            .expect("restore fixtures array")
            .push(Value::String("Q513/R3/D0".to_owned()));
        restore["minimumOperationReportRecords"]["Q513/R3/D0"] = Value::from(0);
        restore["postOperationShape"]["Q513/R3/D0"]["rosterRecords"] = Value::from(0);
        fs::write(
            &manifest,
            serde_json::to_vec_pretty(&manifest_value).expect("serialize probe manifest"),
        )
        .expect("write probe manifest");
        fs::copy(&canonical_schema, &schema).expect("copy probe schema");

        let fixture = fixture_directory.join("Q513__R3__D0.db");
        run_capacity(&[
            "fixture",
            manifest.to_str().expect("manifest path"),
            "Q513/R3/D0",
            fixture.to_str().expect("fixture path"),
        ]);
        let binary = env!("CARGO_BIN_EXE_nir1-material-capacity");
        let probe_args = vec![
            binary.to_owned(),
            manifest.to_str().expect("manifest path").to_owned(),
            fixture_directory
                .to_str()
                .expect("fixture directory")
                .to_owned(),
            output_directory
                .to_str()
                .expect("output directory")
                .to_owned(),
            "nir1-capacity-fixture-project".to_owned(),
            "--fixture".to_owned(),
            "Q513/R3/D0".to_owned(),
            "--mode".to_owned(),
            "restore".to_owned(),
            "--runs".to_owned(),
            "5".to_owned(),
        ];
        let report = run_capacity_probe(&probe, &probe_args);
        assert_eq!(report["diagnosticOnly"], true);
        assert_eq!(report["supportedCapacityClaim"], false);
        let result = &report["results"][0];
        assert_eq!(result["fixture"]["id"], "Q513/R3/D0");
        assert_eq!(result["modeResults"].as_array().map(Vec::len), Some(1));
        let mode = &result["modeResults"][0];
        assert_eq!(mode["mode"], "restore");
        assert_eq!(mode["fixtureShape"]["rosterRecords"], 513);
        assert_eq!(mode["warmup"]["fixtureShape"]["rosterRecords"], 513);
        assert_eq!(mode["warmup"]["counts"]["rosterRecords"], 0);
        assert!(
            mode["runs"]
                .as_array()
                .expect("measured probe runs")
                .iter()
                .all(|run| run["fixtureShape"]["rosterRecords"] == 513
                    && run["counts"]["rosterRecords"] == 0
                    && run["modeOutcome"]["success"] == true
                    && run["modeOutcome"]["requiredSuccess"] == true),
            "probe must validate pre-run fixture shape separately from Restore Graph shape"
        );
        assert_eq!(
            mode["warmup"]["graphLifecycle"]["restoreProof"]["postRestoreRosterRecords"],
            0
        );
    }));

    let _ = fs::remove_dir_all(&probe_root);
    if let Err(payload) = result {
        std::panic::resume_unwind(payload);
    }
}
