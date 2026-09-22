#![cfg(feature = "nir1-material-diagnostics")]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::process::Command;

fn digest(path: &Path) -> String {
    hex::encode(Sha256::digest(fs::read(path).expect("read fixture")))
}

/// This qualification deliberately starts real release children and seeds
/// large Native A2 inputs. Keep it separate from routine library checks.
#[test]
#[ignore = "explicit release capacity qualification; creates eight boundary fixtures"]
fn ratified_capacity_boundaries_in_fresh_processes() {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let manifest_path = repository.join("evals/nir1-capacity/boundaries.v1.json");
    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    let output = std::env::var_os("NIR1_CAPACITY_BOUNDARY_OUTPUT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("nir1-boundaries-{}", uuid::Uuid::new_v4()))
        });
    fs::create_dir_all(&output).unwrap();
    assert!(
        !output.join("complete.json").exists(),
        "do not overwrite a qualification"
    );
    let binary = Path::new(env!("CARGO_BIN_EXE_nir1-material-capacity"));
    let mut receipts = Vec::new();
    for (index, fixture) in manifest["fixtures"].as_array().unwrap().iter().enumerate() {
        let id = fixture["id"].as_str().unwrap();
        let source = output.join(format!("source-{index}.db"));
        assert!(!source.exists(), "fresh fixture required");
        let seeded = Command::new(binary)
            .args([
                "fixture",
                manifest_path.to_str().unwrap(),
                id,
                source.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        fs::write(
            output.join(format!("fixture-{index}.stdout")),
            &seeded.stdout,
        )
        .unwrap();
        fs::write(
            output.join(format!("fixture-{index}.stderr")),
            &seeded.stderr,
        )
        .unwrap();
        let refusal = fixture["refusal"].as_str();
        if let Some(field) = refusal {
            let error = if seeded.status.success() {
                let fixture_report: Value = serde_json::from_slice(&seeded.stdout).unwrap();
                let observation = &fixture_report["observed"];
                assert_eq!(observation["status"], "failed", "N+1 qualified: {id}");
                assert_eq!(observation["modeOutcome"]["success"], false);
                assert_eq!(observation["graphLifecycle"]["published"], false);
                observation["graphLifecycle"]["terminalError"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            } else {
                String::from_utf8_lossy(&seeded.stderr).into_owned()
            };
            assert!(
                error.contains("capacity-exceeded") && error.contains(field),
                "{id}: {error}"
            );
        } else {
            assert!(
                seeded.status.success(),
                "{id}: {}",
                String::from_utf8_lossy(&seeded.stderr)
            );
        }
        // N+1 seeding closes/checkpoints the real source before the builder's
        // disposable qualification fails. Probe that source in a new child.
        let before = digest(&source);
        let modes = fixture["modes"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![json!("full-build")]);
        for mode in modes {
            let mode = mode.as_str().unwrap();
            let child = output.join(format!("child-{index}-{mode}.db"));
            fs::copy(&source, &child).unwrap();
            let started = std::time::Instant::now();
            let result = Command::new(binary)
                .args([
                    child.to_str().unwrap(),
                    id,
                    "nir1-capacity-fixture-project",
                    "--mode",
                    mode,
                ])
                .output()
                .unwrap();
            let elapsed = started.elapsed().as_secs_f64();
            fs::write(
                output.join(format!("child-{index}-{mode}.stderr")),
                &result.stderr,
            )
            .unwrap();
            if let Some(field) = refusal {
                assert!(
                    !result.status.success(),
                    "N+1 child unexpectedly succeeded: {id}"
                );
                assert!(
                    result.stdout.is_empty(),
                    "refusal must emit no successful report"
                );
                let error = String::from_utf8_lossy(&result.stderr);
                assert!(
                    error.contains("capacity-exceeded") && error.contains(field),
                    "{id}: {error}"
                );
                let conn = rusqlite::Connection::open(&child).unwrap();
                assert_eq!(
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_semantic_index_metadata",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                    0,
                    "refusal published a generation"
                );
                receipts.push(json!({"id":id,"mode":mode,"outcome":"safe-refusal","field":field,"seconds":elapsed}));
            } else {
                assert!(
                    result.status.success(),
                    "{id}/{mode}: {}",
                    String::from_utf8_lossy(&result.stderr)
                );
                let report: Value = serde_json::from_slice(&result.stdout).unwrap();
                assert_eq!(report["status"], "measured");
                assert_eq!(report["modeOutcome"]["success"], true);
                assert_eq!(report["modeOutcome"]["requiredSuccess"], true);
                let process = &report["process"];
                let rss = ["totalPeakRssBytes", "hwmRssBytes", "ruMaxrssBytes"]
                    .iter()
                    .filter_map(|key| process[*key].as_u64())
                    .max()
                    .expect("RSS proof");
                let heap = process["rustHeap"]["peakRequestedBytes"]
                    .as_u64()
                    .expect("Rust heap proof");
                let disk = process["temporaryDisk"]["logicalHighWaterUpperBoundBytes"]
                    .as_u64()
                    .expect("complete temporary disk bound");
                for (value, field) in [
                    (rss, "rssBytes"),
                    (heap, "rustHeapBytes"),
                    (disk, "temporaryLogicalBytesUpperBound"),
                ] {
                    assert!(
                        value <= manifest["qualification"][field].as_u64().unwrap(),
                        "{id}/{mode} {field}: {value}"
                    );
                }
                assert!(report["sql"]["lifecycleVmStepsUpperBound"]
                    .as_u64()
                    .is_some());
                fs::write(
                    output.join(format!("child-{index}-{mode}.json")),
                    &result.stdout,
                )
                .unwrap();
                receipts.push(json!({"id":id,"mode":mode,"outcome":"success","rssBytes":rss,"heapBytes":heap,"diskUpperBytes":disk,"seconds":elapsed}));
            }
            assert_eq!(digest(&source), before, "immutable source changed");
            println!("qualified {id}/{mode}: {}", receipts.last().unwrap());
        }
    }
    fs::write(output.join("complete.json"), serde_json::to_vec_pretty(&json!({
        "binarySha256":digest(binary),"manifestSha256":digest(&manifest_path),"receipts":receipts
    })).unwrap()).unwrap();
    println!("capacity qualification: {}", output.display());
}
