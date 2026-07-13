use serde::Deserialize;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
struct Manifest {
    version: u32,
    tools: Vec<Tool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tool {
    name: String,
    capability: String,
    required_policy: Option<String>,
    allowed_channels: Vec<String>,
    requires_user_confirmation: bool,
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../agent-tool-manifest.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let manifest: Manifest = serde_json::from_str(&fs::read_to_string(&manifest_path)?)?;
    if manifest.version != 1 {
        return Err(format!(
            "unsupported agent tool manifest version {}",
            manifest.version
        )
        .into());
    }

    let mut names = HashSet::new();
    let mut read_only = Vec::new();
    let mut mutating = Vec::new();
    for tool in &manifest.tools {
        if tool.name.is_empty()
            || !tool
                .name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            return Err(format!("invalid tool name in manifest: {}", tool.name).into());
        }
        if !names.insert(tool.name.clone()) {
            return Err(format!("duplicate tool in manifest: {}", tool.name).into());
        }
        if !matches!(tool.capability.as_str(), "read" | "write" | "destructive") {
            return Err(format!("invalid capability for {}", tool.name).into());
        }
        if tool.capability == "read" && tool.required_policy.is_some() {
            return Err(format!("read tool {} must not require a policy", tool.name).into());
        }
        if tool.capability != "read" && tool.required_policy.is_none() {
            return Err(format!("mutating tool {} must require a policy", tool.name).into());
        }
        if tool.allowed_channels.is_empty() {
            return Err(format!("tool {} has no allowed channels", tool.name).into());
        }
        if tool.requires_user_confirmation && tool.capability == "read" {
            return Err(format!("read tool {} cannot require confirmation", tool.name).into());
        }
        if tool.capability == "read" {
            read_only.push(tool.name.as_str());
        } else {
            mutating.push(tool.name.as_str());
        }
    }

    let generated = format!(
        "// @generated from agent-tool-manifest.json\n\
         pub(crate) const HERMES_READ_ONLY_TOOL_NAMES: &[&str] = &{read_only:?};\n\
         #[allow(dead_code)]\n\
         pub(crate) const HERMES_BLOCKED_TOOL_NAMES: &[&str] = &{mutating:?};\n"
    );
    let out_path = PathBuf::from(std::env::var("OUT_DIR")?).join("agent_tool_manifest.rs");
    fs::write(out_path, generated)?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("agent tool manifest validation failed: {error}");
        std::process::exit(1);
    }
}
