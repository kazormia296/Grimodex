use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

use super::hash::content_hash;
use super::io::{file_mtime_iso, read_text_file};
use super::path::{canonicalize_mount_root, rel_path_from_canonical};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedDir {
    pub rel_path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    pub rel_path: String,
    pub content: String,
    pub mtime: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub dirs: Vec<ScannedDir>,
    pub files: Vec<ScannedFile>,
}

/// Recursively scan `root` for `.md` files and intermediate directories.
/// Symlinks are not followed (`follow_links = false`).
pub fn scan_root(root: &Path) -> Result<ScanResult> {
    let canonical_root = canonicalize_mount_root(root)?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    walk(&canonical_root, &canonical_root, &mut dirs, &mut files)?;
    dirs.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(ScanResult { dirs, files })
}

fn walk(
    root: &Path,
    current: &Path,
    dirs: &mut Vec<ScannedDir>,
    files: &mut Vec<ScannedFile>,
) -> Result<()> {
    let entries = fs::read_dir(current)
        .with_context(|| format!("failed to read dir {}", current.display()))?;
    for entry in entries {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            let rel = rel_path_from_canonical(root, &path)?;
            if !rel.is_empty() {
                dirs.push(ScannedDir {
                    name: path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string(),
                    rel_path: rel,
                });
            }
            walk(root, &path, dirs, files)?;
        } else if file_type.is_file() {
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let rel = rel_path_from_canonical(root, &path)?;
            let content = read_text_file(&path)?;
            let mtime = file_mtime_iso(&path)?;
            let hash = content_hash(&content);
            files.push(ScannedFile {
                rel_path: rel,
                content,
                mtime,
                content_hash: hash,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn scan_finds_md_files_and_dirs() {
        let dir = std::env::temp_dir().join(format!("grimodex-scan-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("chapter")).unwrap();
        fs::write(dir.join("chapter/01-intro.md"), "# Intro\n").unwrap();
        fs::write(dir.join("notes.md"), "note").unwrap();

        let result = scan_root(&dir).unwrap();
        assert_eq!(result.files.len(), 2);
        assert!(result.dirs.iter().any(|d| d.rel_path == "chapter"));

        fs::remove_dir_all(&dir).ok();
    }
}
