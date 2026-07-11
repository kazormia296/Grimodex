use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use grimodex_db::ime_export::{get_status, ImeIntegrationMode};
use serde_json::{json, Value};

type TestResult = Result<(), Box<dyn Error>>;

struct Sandbox(PathBuf);

impl Sandbox {
    fn new() -> Result<Self, Box<dyn Error>> {
        let path = std::env::temp_dir().join(format!(
            "grimodex-ime-contract-enforcement-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_consumer(root: &Path, id: &str, value: &Value) -> Result<(), Box<dyn Error>> {
    let dir = root.join("consumers");
    fs::create_dir_all(&dir)?;
    fs::write(dir.join(format!("{id}.json")), serde_json::to_vec(value)?)?;
    Ok(())
}

fn handshake(id: &str) -> Value {
    json!({
        "format_version": 1,
        "consumer_id": id,
        "name": "Contract Test IME",
        "version": "1.0.0",
        "platform": "linux",
        "capabilities": { "profile": true },
        "last_seen": "2026-07-11T00:00:00.000Z"
    })
}

#[test]
fn consumer_detection_enforces_schema_but_ignores_future_platform_values() -> TestResult {
    let sandbox = Sandbox::new()?;

    let mut missing_profile = handshake("missing-profile");
    missing_profile["capabilities"] = json!({});
    write_consumer(sandbox.path(), "missing-profile", &missing_profile)?;

    let mut invalid_platform = handshake("invalid-platform");
    invalid_platform["platform"] = json!("!!!");
    write_consumer(sandbox.path(), "invalid-platform", &invalid_platform)?;

    let mut padded_timestamp = handshake("padded-timestamp");
    padded_timestamp["last_seen"] = json!(" 2026-07-11T00:00:00.000Z ");
    write_consumer(sandbox.path(), "padded-timestamp", &padded_timestamp)?;

    let mut future_platform = handshake("future-platform");
    future_platform["platform"] = json!("future-os");
    future_platform["capabilities"]["future_capability"] = json!(true);
    write_consumer(sandbox.path(), "future-platform", &future_platform)?;

    let status = serde_json::to_value(get_status(
        sandbox.path(),
        ImeIntegrationMode::Auto,
    )?)?;
    let consumers = status["consumers"]
        .as_array()
        .ok_or("consumers must be an array")?;
    assert_eq!(consumers.len(), 1);
    assert_eq!(consumers[0]["consumerId"], "future-platform");
    assert!(consumers[0]["platform"].is_null());
    Ok(())
}

#[test]
fn consumer_detection_enforces_the_timestamp_lexical_grammar() -> TestResult {
    let sandbox = Sandbox::new()?;
    for (id, timestamp) in [
        ("lowercase-z", "2026-07-11T00:00:00.000z"),
        ("space-separator", "2026-07-11 00:00:00.000Z"),
        ("long-fraction", "2026-07-11T00:00:00.0000000000Z"),
    ] {
        let mut value = handshake(id);
        value["last_seen"] = json!(timestamp);
        write_consumer(sandbox.path(), id, &value)?;
    }

    let status = serde_json::to_value(get_status(
        sandbox.path(),
        ImeIntegrationMode::Auto,
    )?)?;
    assert_eq!(status["consumers"].as_array().map(Vec::len), Some(0));
    Ok(())
}

#[test]
fn status_rejects_an_oversized_state_file_before_parsing() -> TestResult {
    let sandbox = Sandbox::new()?;
    let oversized = json!({
        "format_version": 1,
        "active_project_id": null,
        "updated_at": "2026-07-11T00:00:00.000Z",
        "padding": "x".repeat(65_536)
    });
    fs::write(
        sandbox.path().join("state.json"),
        serde_json::to_vec(&oversized)?,
    )?;

    assert!(get_status(sandbox.path(), ImeIntegrationMode::On).is_err());
    Ok(())
}

#[test]
fn status_rejects_a_state_with_a_schema_invalid_timestamp() -> TestResult {
    let sandbox = Sandbox::new()?;
    fs::write(
        sandbox.path().join("state.json"),
        serde_json::to_vec(&json!({
            "format_version": 1,
            "active_project_id": null,
            "updated_at": "2026-07-11 00:00:00Z"
        }))?,
    )?;

    assert!(get_status(sandbox.path(), ImeIntegrationMode::On).is_err());
    Ok(())
}

#[test]
fn status_ignores_an_oversized_project_snapshot_before_parsing() -> TestResult {
    let sandbox = Sandbox::new()?;
    let projects = sandbox.path().join("projects");
    fs::create_dir_all(&projects)?;
    let oversized = json!({
        "format_version": 1,
        "project_id": "oversized",
        "project_name": "Oversized",
        "generated_at": "2026-07-11T00:00:00.000Z",
        "entries": [],
        "padding": "x".repeat(16 * 1024 * 1024)
    });
    fs::write(
        projects.join("oversized.json"),
        serde_json::to_vec(&oversized)?,
    )?;

    let status = serde_json::to_value(get_status(
        sandbox.path(),
        ImeIntegrationMode::On,
    )?)?;
    assert_eq!(status["exportedProjectCount"], 0);
    Ok(())
}

#[test]
fn status_does_not_count_a_project_with_a_schema_invalid_timestamp() -> TestResult {
    let sandbox = Sandbox::new()?;
    let projects = sandbox.path().join("projects");
    fs::create_dir_all(&projects)?;
    fs::write(
        projects.join("invalid-time.json"),
        serde_json::to_vec(&json!({
            "format_version": 1,
            "project_id": "invalid-time",
            "project_name": "Invalid time",
            "generated_at": "2026-07-11T00:00:00z",
            "entries": []
        }))?,
    )?;

    let status = serde_json::to_value(get_status(
        sandbox.path(),
        ImeIntegrationMode::On,
    )?)?;
    assert_eq!(status["exportedProjectCount"], 0);
    Ok(())
}
