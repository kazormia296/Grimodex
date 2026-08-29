#![cfg(feature = "c2zc-fixture-builder")]

use grimodex_db::narrative_extraction::c2zc_restore_fixture::{
    build_offline_restore_fixture, verify_manifest, verify_manifest_against_candidate,
    FixtureBuildOptions,
};
use grimodex_db::narrative_extraction::{
    rebuild_narrative_derived_state_for_project, run_dependency_verify_for_project,
    RebuildDerivedStateOutcome,
};
use grimodex_db::Database;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use serde_json::Value;

fn candidate_and_output() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "grimodex-c2zc-fixture-candidate-{}",
        uuid::Uuid::new_v4()
    ));
    let output = root
        .parent()
        .expect("temp directory parent")
        .join(format!("grimodex-c2zc-fixture-output-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).expect("candidate directory");
    fs::write(root.join("candidate.txt"), "candidate\n").expect("candidate file");
    run_git(&root, &["init", "--quiet"]);
    run_git(&root, &["config", "user.name", "fixture"]);
    run_git(&root, &["config", "user.email", "fixture@example.invalid"]);
    run_git(&root, &["add", "candidate.txt"]);
    run_git(&root, &["commit", "--quiet", "-m", "candidate"]);
    (root, output)
}

fn run_git(root: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(root)
        .args(args)
        .status()
        .expect("git");
    assert!(status.success(), "git {:?} failed", args);
}

#[test]
fn offline_restore_fixture_builder_has_a_candidate_bound_contract() {
    let (candidate, output) = candidate_and_output();
    let options = FixtureBuildOptions::new(&candidate, &output)
        .with_builder_command(vec!["c2zc-restore-fixture".to_string(), "build".to_string()]);
    let result = build_offline_restore_fixture(options).expect("fixture builder");

    assert!(!result.manifest.c2zc_marker_present);
    assert_eq!(result.manifest.semantic.project_count, 1);
    assert_eq!(result.manifest.semantic.scene_count, 1);
    assert_eq!(result.manifest.semantic.e0_count, 1);
    assert_eq!(result.manifest.semantic.completed_backfill_count, 1);
    assert_eq!(result.manifest.semantic.dependency_edge_count, 1);
    assert_eq!(result.manifest.semantic.edge_state_count, 0);
    assert_eq!(result.manifest.semantic.owner_freshness_count, 0);
    assert_eq!(result.manifest.semantic.semantic_index_rows, 0);
    assert!(result.manifest.semantic.cursor_settled);
    assert_eq!(
        result.manifest.fixture_sha256,
        result.manifest.artifacts.fixture.sha256
    );
    assert_eq!(
        result.manifest.fixture_size_bytes,
        result.manifest.artifacts.fixture.size_bytes
    );
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(!result
            .database_path
            .with_file_name(format!("{}{}", result.database_path.file_name().unwrap().to_string_lossy(), suffix))
            .exists());
    }
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_builder_rejects_dirty_candidate() {
    let (candidate, output) = candidate_and_output();
    fs::write(candidate.join("dirty.txt"), "dirty\n").expect("dirty marker");
    let options = FixtureBuildOptions::new(&candidate, &output);

    let error = build_offline_restore_fixture(options).expect_err("dirty candidate must fail");
    assert!(error.to_string().contains("C2ZC_FIXTURE_CANDIDATE_DIRTY"));
    fs::remove_dir_all(candidate).expect("candidate cleanup");
}

#[test]
fn offline_restore_fixture_drives_production_verify_rebuild_verify() {
    let (candidate, output) = candidate_and_output();
    let result = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect("fixture builder");
    let restored_path = output.join("restored.db");
    fs::copy(&result.backup_path, &restored_path).expect("copy fixture backup");

    let restored = Database::new(&restored_path).expect("open restored fixture");
    restored.migrate().expect("migrate restored fixture");
    let initial = run_dependency_verify_for_project(
        &restored,
        "c2zc-restore-fixture-project",
    )
    .expect("initial Verify");
    assert!(initial.report.requires_rebuild());
    let rebuild = rebuild_narrative_derived_state_for_project(
        &restored,
        "c2zc-restore-fixture-project",
    )
    .expect("conditional Rebuild");
    assert!(matches!(rebuild, RebuildDerivedStateOutcome::Ran { .. }));
    let confirmation = run_dependency_verify_for_project(
        &restored,
        "c2zc-restore-fixture-project",
    )
    .expect("confirmation Verify");
    assert!(!confirmation.report.requires_rebuild());

    drop(restored);
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_manifest_rejects_tampered_backup() {
    let (candidate, output) = candidate_and_output();
    let result = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect("fixture builder");
    let mut bytes = fs::read(&result.backup_path).expect("read fixture backup");
    let last = bytes.len() - 1;
    bytes[last] ^= 0x01;
    fs::write(&result.backup_path, bytes).expect("tamper fixture backup");

    let error = verify_manifest(&result.manifest_path).expect_err("tamper must fail closed");
    assert!(error.to_string().contains("C2ZC_FIXTURE_HASH_MISMATCH"));
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_manifest_rejects_artifact_path_escape() {
    let (candidate, output) = candidate_and_output();
    let result = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect("fixture builder");
    let mut manifest: Value = serde_json::from_slice(
        &fs::read(&result.manifest_path).expect("read manifest"),
    )
    .expect("manifest JSON");
    manifest["artifacts"]["fixture"]["path"] = Value::String("../outside.db".to_string());
    let tampered = output.join("tampered.manifest.json");
    fs::write(
        &tampered,
        serde_json::to_vec_pretty(&manifest).expect("tampered JSON"),
    )
    .expect("write tampered manifest");

    let error = verify_manifest(&tampered).expect_err("path escape must fail closed");
    assert!(error.to_string().contains("C2ZC_FIXTURE_ARTIFACT_PATH_ESCAPE"));
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_rejects_output_inside_candidate_before_writing() {
    let (candidate, _) = candidate_and_output();
    let output = candidate.join("generated");
    let error = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect_err("candidate-contained output must fail closed");
    assert!(error.to_string().contains("C2ZC_FIXTURE_OUTPUT_INSIDE_CANDIDATE"));
    let status = Command::new("git")
        .current_dir(&candidate)
        .args(["status", "--porcelain=v1", "--untracked-files=all"])
        .output()
        .expect("git status");
    assert!(status.status.success());
    assert!(status.stdout.is_empty(), "output rejection dirtied candidate");
    fs::remove_dir_all(candidate).expect("candidate cleanup");
}

#[test]
fn offline_restore_fixture_rechecks_candidate_binding() {
    let (candidate, output) = candidate_and_output();
    let result = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect("fixture builder");
    verify_manifest_against_candidate(&result.manifest_path, &candidate, None)
        .expect("candidate binding");
    fs::write(candidate.join("changed.txt"), "dirty\n").expect("dirty candidate");
    let error = verify_manifest_against_candidate(&result.manifest_path, &candidate, None)
        .expect_err("dirty candidate must fail verification");
    assert!(error.to_string().contains("C2ZC_FIXTURE_CANDIDATE_DIRTY"));
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_rechecks_candidate_before_manifest_publication() {
    let (candidate, output) = candidate_and_output();
    let options = FixtureBuildOptions::new(&candidate, &output)
        .with_before_manifest_publish_hook(|root| {
            fs::write(
                root.join("changed-during-build.txt"),
                "changed while the fixture was being generated\n",
            )
            .map_err(anyhow::Error::from)?;
            run_git(root, &["add", "changed-during-build.txt"]);
            run_git(root, &["commit", "--quiet", "-m", "candidate-during-build"]);
            Ok(())
        });

    let error = build_offline_restore_fixture(options)
        .expect_err("candidate mutation during build must fail closed");
    assert!(error
        .to_string()
        .contains("C2ZC_FIXTURE_CANDIDATE_CHANGED_BEFORE_MANIFEST"));
    assert!(
        !output.join("c2zc-restore-fixture.manifest.json").exists(),
        "candidate recheck failure must not publish a manifest"
    );
    assert!(
        !output.join("c2zc-restore-fixture.db").exists(),
        "candidate recheck failure must clean the database artifact"
    );
    assert!(
        !output.join("c2zc-restore-fixture.backup.db").exists(),
        "candidate recheck failure must clean the fixture artifact"
    );
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_manifest_recomputes_every_semantic_digest_and_matches_db() {
    let (candidate, output) = candidate_and_output();
    let result = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect("fixture builder");
    let original: Value = serde_json::from_slice(
        &fs::read(&result.manifest_path).expect("read manifest"),
    )
    .expect("manifest JSON");

    let semantic_fields = [
        ("/semantic/project", "project"),
        ("/semantic/projectDigest", "project digest"),
        ("/semantic/scene", "scene"),
        ("/semantic/sceneDigest", "scene digest"),
        ("/semantic/epoch", "epoch"),
        ("/semantic/epochDigest", "epoch digest"),
        ("/semantic/backfill", "backfill"),
        ("/semantic/backfillDigest", "backfill digest"),
        ("/semantic/edge", "edge"),
        ("/semantic/edgeDigest", "edge digest"),
        ("/semantic/feedCursor", "feed cursor"),
        ("/semantic/feedCursorDigest", "feed cursor digest"),
        ("/semantic/derivedStateGap", "derived state gap"),
        ("/semantic/derivedStateGapDigest", "derived state gap digest"),
        ("/semantic/semanticIndex", "semantic index"),
        ("/semantic/semanticIndexDigest", "semantic index digest"),
        (
            "/semantic/expectedRestoreLifecycle",
            "expected restore lifecycle",
        ),
        (
            "/semantic/expectedRestoreLifecycleDigest",
            "expected restore lifecycle digest",
        ),
        ("/semantic/contentsDigest", "contents digest"),
    ];
    for (path, label) in semantic_fields {
        let mut tampered = original.clone();
        let target = tampered
            .pointer_mut(path)
            .unwrap_or_else(|| panic!("manifest field missing for {label}: {path}"));
        *target = if path.ends_with("Digest") {
            Value::String(format!("sha256:{}", "0".repeat(64)))
        } else {
            serde_json::json!({ "tampered": label })
        };
        let tampered_path = output.join(format!(
            "tampered-{}.manifest.json",
            path.replace(['.', '/'], "-")
        ));
        fs::write(
            &tampered_path,
            serde_json::to_vec_pretty(&tampered).expect("tampered JSON"),
        )
        .expect("write tampered manifest");
        let error = verify_manifest(&tampered_path)
            .expect_err("semantic payload or digest mutation must fail closed");
        assert!(
            error.to_string().contains("C2ZC_FIXTURE_SEMANTIC_DIGEST"),
            "{label} mutation produced an unexpected error: {error:#}"
        );
    }

    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_rejects_expected_head_or_tree_mismatch() {
    for (expected_head, expected_tree, expected_code) in [
        (Some("0".repeat(40)), None, "C2ZC_FIXTURE_CANDIDATE_HEAD_MISMATCH"),
        (None, Some("0".repeat(40)), "C2ZC_FIXTURE_CANDIDATE_TREE_MISMATCH"),
    ] {
        let (candidate, output) = candidate_and_output();
        let mut options = FixtureBuildOptions::new(&candidate, &output);
        if let Some(expected) = expected_head {
            options = options.with_expected_head(expected);
        }
        if let Some(expected) = expected_tree {
            options = options.with_expected_tree(expected);
        }
        let error = build_offline_restore_fixture(options)
            .expect_err("mismatched candidate binding must fail closed");
        assert!(error.to_string().contains(expected_code));
        assert!(
            !output.exists(),
            "candidate binding mismatch must not create an output directory"
        );
        fs::remove_dir_all(candidate).expect("candidate cleanup");
    }
}

#[cfg(unix)]
#[test]
fn offline_restore_fixture_rejects_symlinked_candidate_and_artifact_paths() {
    use std::os::unix::fs::symlink;

    let (candidate, output) = candidate_and_output();
    let candidate_alias = output
        .parent()
        .expect("temp directory parent")
        .join(format!("grimodex-c2zc-fixture-candidate-alias-{}", uuid::Uuid::new_v4()));
    symlink(&candidate, &candidate_alias).expect("candidate symlink");
    let error = build_offline_restore_fixture(FixtureBuildOptions::new(
        &candidate_alias,
        &output,
    ))
    .expect_err("symlinked candidate must fail closed");
    assert!(error.to_string().contains("C2ZC_FIXTURE_SYMLINK_PATH_REJECTED"));
    assert!(!output.exists());
    fs::remove_file(candidate_alias).expect("candidate alias cleanup");
    fs::remove_dir_all(candidate).expect("candidate cleanup");

    let (candidate, output) = candidate_and_output();
    let result = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect("fixture builder");
    let outside = output
        .parent()
        .expect("temp directory parent")
        .join(format!("grimodex-c2zc-fixture-outside-{}", uuid::Uuid::new_v4()));
    fs::write(&outside, b"not the fixture").expect("outside file");
    fs::remove_file(&result.backup_path).expect("remove backup before symlink");
    symlink(&outside, &result.backup_path).expect("backup symlink");
    let error = verify_manifest(&result.manifest_path)
        .expect_err("symlinked fixture artifact must fail closed");
    assert!(error.to_string().contains("C2ZC_FIXTURE_SYMLINK_PATH_REJECTED"));
    fs::remove_file(&result.backup_path).expect("backup symlink cleanup");
    fs::remove_file(outside).expect("outside file cleanup");
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}
