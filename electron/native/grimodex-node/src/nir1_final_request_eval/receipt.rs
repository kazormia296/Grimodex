//! Receipt file writer (evaluation feature only). The harness names the
//! directory; the receipt and the setup receipt are never committed and never
//! stored in a product database.

use std::io::Write;
use std::path::{Component, Path, PathBuf};

use anyhow::{ensure, Context, Result};
use serde_json::Value;

/// Write `value` as `<dir>/<file_name>` with `create_new` (an existing file is
/// never overwritten). `dir` must have an `.artifacts` path component so a
/// receipt cannot land in the source tree, and `file_name` must be a single
/// plain `.json` file name.
pub(crate) fn write_json_file(dir: &Path, file_name: &str, value: &Value) -> Result<PathBuf> {
    ensure!(
        dir.components()
            .any(|component| component == Component::Normal(".artifacts".as_ref())),
        "NIR1_EVAL_RECEIPT_DIR_NOT_ARTIFACTS"
    );
    ensure!(
        dir.components()
            .all(|component| !matches!(component, Component::ParentDir)),
        "NIR1_EVAL_RECEIPT_DIR_PARENT_COMPONENT"
    );
    let name_ok = file_name.ends_with(".json")
        && file_name.len() > ".json".len()
        && file_name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        && !file_name.starts_with('.');
    ensure!(name_ok, "NIR1_EVAL_RECEIPT_FILE_NAME_INVALID");
    std::fs::create_dir_all(dir).context("NIR1_EVAL_RECEIPT_DIR_CREATE_FAILED")?;
    let path = dir.join(file_name);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .context("NIR1_EVAL_RECEIPT_FILE_EXISTS_OR_UNWRITABLE")?;
    let bytes = serde_json::to_vec_pretty(value)?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(path)
}
