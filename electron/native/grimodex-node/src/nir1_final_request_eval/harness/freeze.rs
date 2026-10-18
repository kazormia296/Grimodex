//! The freeze gate (draft: 作者の分離と freeze の順序). The harness runs Native
//! on the fixture only when the freeze record is `frozen`, binds the bytes of
//! the fixture, the review record, the README, the parity vector and the four
//! scorer modules that this checkout has, was committed before this checkout
//! (it is an ancestor of HEAD) and the checkout is clean.
//!
//! The git calls are the only child processes: each one is synchronous, has no
//! shell and is killed after `GIT_TIMEOUT`. Nothing stays running. The scorer's
//! `verifyFrozenSnapshot` (scripts/quality/nir1-packing/final-request/
//! contract.mjs) repeats and extends this check before it scores a receipt; the
//! two do not share code, so a gate that is wrong in one is caught by the other.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use grimodex_db::narrative_extraction::final_request_eval::sha256_hex;
use serde_json::Value;

pub(super) const FIXTURE_PATH: &str = "evals/nir1-packing/final-request.v1.json";
pub(super) const FREEZE_PATH: &str = "evals/nir1-packing/final-request.freeze.v1.json";
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
/// A freeze record is written once; more commits than this on its path mean it
/// was rewritten after it was frozen.
const MAX_FREEZE_RECORD_COMMITS: usize = 16;

/// What a run binds into its receipts when the gate passes.
#[derive(Clone, Debug)]
pub(super) struct FrozenSnapshot {
    pub(super) run_commit: String,
    pub(super) run_tree: String,
    pub(super) freeze_commit: String,
    pub(super) freeze_path: String,
    pub(super) freeze_record_sha256: String,
    pub(super) fixture_sha256: String,
    /// `scorerDigest` of the freeze record's scorer files.
    pub(super) scorer_sha256: String,
    pub(super) fixture_text: String,
}

/// Why the harness did not run (the run is a HOLD, not a FAIL).
#[derive(Clone, Debug, Default)]
pub(super) struct FreezeRefusal {
    pub(super) reasons: Vec<String>,
}

struct GitOutput {
    status: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

fn run_git(repo_root: &Path, args: &[&str]) -> Result<GitOutput> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("git could not be started")?;
    let deadline = Instant::now() + GIT_TIMEOUT;
    // Drain the pipes on helper threads so a large `git show` cannot fill the
    // pipe and stall the child while this thread waits for it.
    let mut stdout_pipe = child.stdout.take().context("git stdout missing")?;
    let mut stderr_pipe = child.stderr.take().context("git stderr missing")?;
    let stdout_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buffer);
        buffer
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buffer);
        buffer
    });
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(anyhow!("git {} timed out", args.join(" ")));
            }
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&stderr_reader.join().unwrap_or_default()).into_owned();
    Ok(GitOutput {
        status: status.code(),
        stdout,
        stderr,
    })
}

fn git_ok(repo_root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = run_git(repo_root, args)?;
    if output.status != Some(0) {
        return Err(anyhow!(
            "git {} failed: {}",
            args.join(" "),
            output.stderr.lines().next().unwrap_or("")
        ));
    }
    Ok(output.stdout)
}

fn git_line(repo_root: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8_lossy(&git_ok(repo_root, args)?)
        .trim()
        .to_owned())
}

/// `scorerDigest`: sha256 over `<path>\t<sha256>\n` lines sorted by path.
fn scorer_digest(files: &[(String, String)]) -> String {
    let mut sorted = files.to_vec();
    sorted.sort_by(|left, right| left.0.cmp(&right.0));
    let lines: String = sorted
        .iter()
        .map(|(path, sha)| format!("{path}\t{sha}\n"))
        .collect();
    sha256_hex(lines.as_bytes())
}

/// The bound files of a freeze record: (path, recorded sha256).
fn bound_files(freeze: &Value) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    for key in ["fixture", "reviewRecord", "readme", "parityVector"] {
        if let (Some(path), Some(sha)) =
            (freeze[key]["path"].as_str(), freeze[key]["sha256"].as_str())
        {
            entries.push((path.to_owned(), sha.to_owned()));
        }
    }
    for file in freeze["scorer"]["files"].as_array().into_iter().flatten() {
        if let (Some(path), Some(sha)) = (file["path"].as_str(), file["sha256"].as_str()) {
            entries.push((path.to_owned(), sha.to_owned()));
        }
    }
    entries
}

fn status_is_frozen(bytes: &[u8]) -> bool {
    serde_json::from_slice::<Value>(bytes)
        .map(|record| record["status"] == "frozen")
        .unwrap_or(false)
}

/// The freeze gate. `expected_freeze_commit`, when given, must be the commit
/// derived from history (a receipt's `freeze.commit`).
pub(super) fn check_freeze(
    repo_root: &Path,
    expected_freeze_commit: Option<&str>,
) -> std::result::Result<FrozenSnapshot, FreezeRefusal> {
    let mut refusal = FreezeRefusal::default();
    let mut refuse = |reason: String| refusal.reasons.push(reason);

    let run_commit = git_line(repo_root, &["rev-parse", "HEAD"]);
    let run_tree = git_line(repo_root, &["rev-parse", "HEAD^{tree}"]);
    let (run_commit, run_tree) = match (run_commit, run_tree) {
        (Ok(commit), Ok(tree)) => (commit, tree),
        (Err(error), _) | (_, Err(error)) => {
            refuse(format!("the run commit could not be read: {error}"));
            return Err(refusal);
        }
    };

    // A dirty checkout is not a candidate: the receipt names HEAD, so what ran
    // must be HEAD.
    match run_git(
        repo_root,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    ) {
        Ok(output) if output.status == Some(0) => {
            let dirty = String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count();
            if dirty > 0 {
                refuse(format!(
                    "workspace-not-clean: {dirty} path(s) differ from HEAD {run_commit}"
                ));
            }
        }
        Ok(output) => refuse(format!("git status failed: {}", output.stderr)),
        Err(error) => refuse(format!("git status could not run: {error}")),
    }

    let freeze_bytes = match std::fs::read(repo_root.join(FREEZE_PATH)) {
        Ok(bytes) => bytes,
        Err(error) => {
            refuse(format!("{FREEZE_PATH} could not be read: {error}"));
            return Err(refusal);
        }
    };
    let freeze: Value = match serde_json::from_slice(&freeze_bytes) {
        Ok(value) => value,
        Err(error) => {
            refuse(format!("{FREEZE_PATH} is not JSON: {error}"));
            return Err(refusal);
        }
    };
    if freeze["status"] != "frozen" {
        refuse(format!(
            "freeze-record-not-frozen: status is {}, not \"frozen\" (the independent expectation review has not approved the fixture)",
            freeze["status"]
        ));
    }

    // The bytes this checkout has are the bytes the record binds.
    let bound = bound_files(&freeze);
    if bound.len() < 8 {
        refuse(format!(
            "the freeze record binds {} files, expected the fixture, review, README, parity vector and four scorer modules",
            bound.len()
        ));
    }
    let mut fixture_sha256 = String::new();
    let mut fixture_text = String::new();
    let mut scorer_files = Vec::new();
    for (path, recorded) in &bound {
        match std::fs::read(repo_root.join(path)) {
            Ok(bytes) => {
                let actual = sha256_hex(&bytes);
                if actual != *recorded {
                    refuse(format!(
                        "{path} has sha256 {actual}, the freeze record binds {recorded}"
                    ));
                }
                if path == FIXTURE_PATH {
                    fixture_sha256 = actual;
                    fixture_text = String::from_utf8_lossy(&bytes).into_owned();
                }
                if path.starts_with("scripts/quality/nir1-packing/final-request/") {
                    scorer_files.push((path.clone(), recorded.clone()));
                }
            }
            Err(error) => refuse(format!("{path} could not be read: {error}")),
        }
    }
    if fixture_sha256.is_empty() {
        refuse(format!("the freeze record does not bind {FIXTURE_PATH}"));
    }

    // The freeze commit is derived from history: the oldest commit reachable
    // from HEAD whose version of the record is frozen.
    let freeze_commit = derive_freeze_commit(repo_root);
    let freeze_commit = match freeze_commit {
        Ok(commit) => Some(commit),
        Err(reason) => {
            refuse(reason);
            None
        }
    };
    if let Some(commit) = &freeze_commit {
        if let Some(expected) = expected_freeze_commit {
            if expected != commit {
                refuse(format!(
                    "freeze commit {expected} is not the first commit that held the frozen record ({commit})"
                ));
            }
        }
        match run_git(
            repo_root,
            &["merge-base", "--is-ancestor", commit, &run_commit],
        ) {
            Ok(output) if output.status == Some(0) => {}
            Ok(output) if output.status == Some(1) => refuse(format!(
                "freeze commit {commit} is not an ancestor of run commit {run_commit}"
            )),
            Ok(output) => refuse(format!(
                "freeze order could not be verified: {}",
                output.stderr.lines().next().unwrap_or("")
            )),
            Err(error) => refuse(format!("freeze order could not be verified: {error}")),
        }
        // Nothing the record binds (nor the record) changed after the freeze.
        let mut paths: Vec<&str> = bound.iter().map(|(path, _)| path.as_str()).collect();
        paths.push(FREEZE_PATH);
        for path in paths {
            let at_freeze = run_git(repo_root, &["show", &format!("{commit}:{path}")]);
            match at_freeze {
                Ok(output) if output.status == Some(0) => {
                    let now = std::fs::read(repo_root.join(path)).unwrap_or_default();
                    if sha256_hex(&output.stdout) != sha256_hex(&now) {
                        refuse(format!(
                            "{path} differs from the frozen bytes at {commit} (it was changed after the freeze)"
                        ));
                    }
                }
                _ => refuse(format!(
                    "{path} does not exist at the freeze commit {commit}"
                )),
            }
        }
    }

    if !refusal.reasons.is_empty() {
        return Err(refusal);
    }
    Ok(FrozenSnapshot {
        run_commit,
        run_tree,
        freeze_commit: freeze_commit.unwrap_or_default(),
        freeze_path: FREEZE_PATH.to_owned(),
        freeze_record_sha256: sha256_hex(&freeze_bytes),
        fixture_sha256,
        scorer_sha256: scorer_digest(&scorer_files),
        fixture_text,
    })
}

fn derive_freeze_commit(repo_root: &Path) -> std::result::Result<String, String> {
    let listing = git_line_multi(
        repo_root,
        &["log", "--reverse", "--format=%H", "HEAD", "--", FREEZE_PATH],
    )
    .map_err(|error| format!("freeze record history could not be read: {error}"))?;
    if listing.is_empty() {
        return Err(format!("no commit holds {FREEZE_PATH}"));
    }
    if listing.len() > MAX_FREEZE_RECORD_COMMITS {
        return Err(format!(
            "the freeze record was touched by {} commits (more than {MAX_FREEZE_RECORD_COMMITS}); it must be written once, when it is frozen",
            listing.len()
        ));
    }
    for commit in &listing {
        let shown = run_git(repo_root, &["show", &format!("{commit}:{FREEZE_PATH}")])
            .map_err(|error| format!("freeze record at {commit} could not be read: {error}"))?;
        if shown.status == Some(0) && status_is_frozen(&shown.stdout) {
            return Ok(commit.clone());
        }
    }
    Err("no commit holds a frozen freeze record".to_owned())
}

fn git_line_multi(repo_root: &Path, args: &[&str]) -> Result<Vec<String>> {
    Ok(String::from_utf8_lossy(&git_ok(repo_root, args)?)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

/// The repository root of this checkout.
pub(super) fn repository_root() -> Result<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    Ok(PathBuf::from(git_line(
        manifest,
        &["rev-parse", "--show-toplevel"],
    )?))
}

/// The commit the checkout is at.
pub(super) fn head_commit(repo_root: &Path) -> Result<String> {
    git_line(repo_root, &["rev-parse", "HEAD"])
}
