use std::collections::HashSet;
use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Serialize;

use super::hash::content_hash;
use super::io::{file_mtime_iso, read_text_file};
use super::path::{canonicalize_mount_root, rel_path_from_canonical};

/// Maximum directory nesting depth while scanning a mount root.
pub(crate) const MAX_SCAN_DEPTH: u32 = 64;

/// Maximum number of `.md` files materialized in one scan. Mirrors the ZIP
/// import limit (markdownParser `MAX_MARKDOWN_ENTRIES`). Without this, mounting
/// an attacker-prepared folder with millions of small `.md` files exhausts
/// memory while the whole `ScanResult` is held + JSON-serialized to the
/// renderer (RUST-DOS: scan_root has no count/byte cap, only a per-file limit).
pub(crate) const MAX_SCAN_FILES: usize = 50_000;

/// Maximum cumulative `.md` content bytes materialized in one scan (256 MiB).
/// Mirrors the ZIP import limit (markdownParser `MAX_MARKDOWN_TOTAL_BYTES`).
pub(crate) const MAX_SCAN_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

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
    let mut visited = HashSet::new();
    let mut total_bytes: u64 = 0;
    walk(
        &canonical_root,
        &canonical_root,
        0,
        &mut visited,
        &mut dirs,
        &mut files,
        &mut total_bytes,
    )?;
    dirs.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(ScanResult { dirs, files })
}

#[allow(clippy::too_many_arguments)]
fn walk(
    root: &Path,
    current: &Path,
    depth: u32,
    visited: &mut HashSet<DirVisitKey>,
    dirs: &mut Vec<ScannedDir>,
    files: &mut Vec<ScannedFile>,
    total_bytes: &mut u64,
) -> Result<()> {
    if depth > MAX_SCAN_DEPTH {
        bail!(
            "scan depth exceeded maximum of {MAX_SCAN_DEPTH} at {}",
            current.display()
        );
    }

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
            let dir_key = dir_key(&path)?;
            if !visited.insert(dir_key) {
                tracing::warn!(
                    "skipping already visited directory during scan: {}",
                    path.display()
                );
                continue;
            }

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
            walk(root, &path, depth + 1, visited, dirs, files, total_bytes)?;
        } else if file_type.is_file() {
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            // 累積上限 (件数 / バイト) を超えたら scan 全体を弾く。攻撃者フォルダの
            // 大量/大サイズ .md でメモリ枯渇 → renderer 転送で DoS になるのを防ぐ。
            if files.len() >= MAX_SCAN_FILES {
                bail!("scan exceeded maximum of {MAX_SCAN_FILES} markdown files");
            }
            let rel = rel_path_from_canonical(root, &path)?;
            // oversize / 読込失敗の1ファイルで scan 全体 (ひいてはプロセス) を
            // 落とさず、該当ファイルだけ skip + warn する (security audit RUST-DOS-01)。
            let content = match read_text_file(&path) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(
                        "skipping unreadable file during scan: {} ({e:#})",
                        path.display()
                    );
                    continue;
                }
            };
            *total_bytes = total_bytes.saturating_add(content.len() as u64);
            if *total_bytes > MAX_SCAN_TOTAL_BYTES {
                bail!(
                    "scan exceeded cumulative size limit of {} MiB",
                    MAX_SCAN_TOTAL_BYTES / (1024 * 1024)
                );
            }
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

#[derive(Debug, Clone, Hash, Eq, PartialEq)]
enum DirVisitKey {
    #[cfg(unix)]
    Inode(u64, u64),
    #[cfg(not(unix))]
    CanonicalPath(String),
}

fn dir_key(path: &Path) -> Result<DirVisitKey> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::metadata(path)
            .with_context(|| format!("failed to stat directory {}", path.display()))?;
        Ok(DirVisitKey::Inode(meta.dev(), meta.ino()))
    }

    #[cfg(windows)]
    {
        let canonical = path
            .canonicalize()
            .with_context(|| format!("failed to canonicalize directory {}", path.display()))?;
        Ok(DirVisitKey::CanonicalPath(
            canonical.to_string_lossy().replace('\\', "/"),
        ))
    }

    #[cfg(not(any(unix, windows)))]
    {
        let canonical = path
            .canonicalize()
            .with_context(|| format!("failed to canonicalize directory {}", path.display()))?;
        Ok(DirVisitKey::CanonicalPath(
            canonical.to_string_lossy().replace('\\', "/"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("grimodex-scan-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn scan_finds_md_files_and_dirs() {
        let dir = temp_dir("basic");
        fs::create_dir_all(dir.join("chapter")).unwrap();
        fs::write(dir.join("chapter/01-intro.md"), "# Intro\n").unwrap();
        fs::write(dir.join("notes.md"), "note").unwrap();

        let result = scan_root(&dir).unwrap();
        assert_eq!(result.files.len(), 2);
        assert!(result.dirs.iter().any(|d| d.rel_path == "chapter"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_errors_when_depth_exceeded() {
        let dir = temp_dir("depth");
        fs::create_dir_all(&dir).unwrap();
        let mut nested = dir.clone();
        for i in 0..=MAX_SCAN_DEPTH {
            nested = nested.join(format!("level-{i}"));
            fs::create_dir_all(&nested).unwrap();
        }
        fs::write(nested.join("deep.md"), "deep").unwrap();

        let err = scan_root(&dir).unwrap_err();
        assert!(err.to_string().contains("scan depth exceeded"));

        fs::remove_dir_all(&dir).ok();
    }
}
