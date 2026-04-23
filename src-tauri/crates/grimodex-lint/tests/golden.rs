//! Golden-file regression harness.
//!
//! Discovers fixtures under `tests/fixtures/<category>/<rule-name>/`, reads
//! `input.txt` as a single Paragraph block, runs the full lint pipeline,
//! and compares the resulting `Vec<Diagnostic>` against `expected.json`.
//!
//! Set `UPDATE_EXPECT=1` to rewrite `expected.json` from the current output.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::fs;
use std::path::{Path, PathBuf};

use grimodex_lint::{
    lint, BlockKind, Diagnostic, Language, LintBlock, LintConfig, LintScope,
};

fn fixtures_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

fn discover_fixtures() -> Vec<PathBuf> {
    let root = fixtures_root();
    if !root.exists() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for cat in fs::read_dir(&root).expect("read fixtures root") {
        let cat = cat.expect("dir entry").path();
        if !cat.is_dir() {
            continue;
        }
        for rule_dir in fs::read_dir(&cat).expect("read category dir") {
            let rule_dir = rule_dir.expect("dir entry").path();
            if rule_dir.is_dir() && rule_dir.join("input.txt").exists() {
                out.push(rule_dir);
            }
        }
    }
    out.sort();
    out
}

fn run_fixture(dir: &Path) -> Vec<Diagnostic> {
    let input = fs::read_to_string(dir.join("input.txt")).expect("read input.txt");
    // Strip a single trailing newline so editors that auto-append one don't
    // change offsets.
    let text = input.strip_suffix('\n').unwrap_or(&input).to_string();

    let blocks = vec![LintBlock {
        id: 0,
        kind: BlockKind::Paragraph,
        text,
        str_offset_start: 0,
    }];
    let resp = lint(
        &blocks,
        Language::Japanese,
        LintScope::Scene {
            scene_id: "fixture".into(),
        },
        &LintConfig::default(),
    )
    .expect("lint run");
    resp.diagnostics
}

fn canonical_json(diagnostics: &[Diagnostic]) -> String {
    let pretty = serde_json::to_string_pretty(diagnostics).expect("serialize diagnostics");
    format!("{}\n", pretty)
}

#[test]
fn golden_fixtures() {
    let update = std::env::var("UPDATE_EXPECT")
        .map(|v| v == "1")
        .unwrap_or(false);

    let fixtures = discover_fixtures();
    if fixtures.is_empty() {
        eprintln!("no fixtures discovered under {}", fixtures_root().display());
        return;
    }

    let mut failures = Vec::new();
    for dir in &fixtures {
        let diagnostics = run_fixture(dir);
        let got = canonical_json(&diagnostics);
        let expected_path = dir.join("expected.json");

        if update {
            fs::write(&expected_path, &got).expect("write expected.json");
            continue;
        }

        let expected = match fs::read_to_string(&expected_path) {
            Ok(s) => s,
            Err(_) => {
                failures.push(format!(
                    "{}: expected.json missing (run with UPDATE_EXPECT=1 to create)",
                    dir.display()
                ));
                continue;
            }
        };

        if expected != got {
            failures.push(format!(
                "{}: diagnostics did not match expected.json\n--- expected\n{}\n--- got\n{}",
                dir.display(),
                expected,
                got
            ));
        }
    }

    if !failures.is_empty() {
        panic!("golden fixtures failed:\n{}", failures.join("\n\n"));
    }
}
