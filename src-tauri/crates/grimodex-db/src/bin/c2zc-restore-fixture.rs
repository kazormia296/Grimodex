use std::env;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use grimodex_db::narrative_extraction::c2zc_restore_fixture::{
    build_offline_restore_fixture, verify_manifest, verify_manifest_against_candidate,
    FixtureBuildOptions,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildOutput<'a> {
    database_path: &'a std::path::Path,
    backup_path: &'a std::path::Path,
    fixture_artifact_path: &'a std::path::Path,
    manifest_path: &'a std::path::Path,
    manifest: &'a grimodex_db::narrative_extraction::c2zc_restore_fixture::FixtureManifest,
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("build") => build(&args),
        Some("verify") => verify(&args),
        _ => bail!(
            "usage: c2zc-restore-fixture build --repo-root <path> --output-dir <path> --candidate <ref> [--expected-head <sha>] [--expected-tree <sha>]\n       c2zc-restore-fixture verify --manifest <path> [--repo-root <path>] [--candidate <ref>]"
        ),
    }
}

fn build(args: &[String]) -> Result<()> {
    let repo_root = required_path_arg(args, "--repo-root")?;
    let output_dir = required_path_arg(args, "--output-dir")?;
    let candidate = required_string_arg(args, "--candidate")?;
    let mut options = FixtureBuildOptions::new(repo_root, output_dir)
        .with_candidate(candidate)
        .with_builder_command(args.to_vec());
    if let Some(expected) = optional_string_arg(args, "--expected-head")? {
        options = options.with_expected_head(expected);
    }
    if let Some(expected) = optional_string_arg(args, "--expected-tree")? {
        options = options.with_expected_tree(expected);
    }
    let result = build_offline_restore_fixture(options).context("building C2-ZC fixture")?;
    println!(
        "{}",
        serde_json::to_string_pretty(&BuildOutput {
            database_path: &result.database_path,
            backup_path: &result.backup_path,
            fixture_artifact_path: &result.backup_path,
            manifest_path: &result.manifest_path,
            manifest: &result.manifest,
        })?
    );
    Ok(())
}

fn verify(args: &[String]) -> Result<()> {
    let manifest = required_path_arg(args, "--manifest")?;
    let verified = if let Some(repo_root) = optional_string_arg(args, "--repo-root")? {
        let candidate = optional_string_arg(args, "--candidate")?;
        verify_manifest_against_candidate(
            &manifest,
            &PathBuf::from(repo_root),
            candidate.as_deref(),
        )
        .context("verifying C2-ZC fixture and candidate binding")?
    } else {
        verify_manifest(&manifest).context("verifying C2-ZC fixture")?
    };
    println!("{}", serde_json::to_string_pretty(&verified)?);
    Ok(())
}

fn required_path_arg(args: &[String], name: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(required_string_arg(args, name)?))
}

fn required_string_arg(args: &[String], name: &str) -> Result<String> {
    let index = args
        .iter()
        .position(|arg| arg == name)
        .ok_or_else(|| anyhow::anyhow!("missing required argument {name}"))?;
    let value = args
        .get(index + 1)
        .filter(|value| !value.starts_with('-'))
        .ok_or_else(|| anyhow::anyhow!("missing value for {name}"))?;
    Ok(value.clone())
}

fn optional_string_arg(args: &[String], name: &str) -> Result<Option<String>> {
    let Some(index) = args.iter().position(|arg| arg == name) else {
        return Ok(None);
    };
    let value = args
        .get(index + 1)
        .filter(|value| !value.starts_with('-'))
        .ok_or_else(|| anyhow::anyhow!("missing value for {name}"))?;
    Ok(Some(value.clone()))
}
