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
