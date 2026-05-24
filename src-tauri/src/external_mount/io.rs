use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, Context, Result};

/// Resolve `rel_path` under `root` and reject path traversal (`..`).
pub fn resolve_under_root(root: &Path, rel_path: &str) -> Result<PathBuf> {
    let rel = Path::new(rel_path);
    for component in rel.components() {
        match component {
            Component::ParentDir => {
                return Err(anyhow!("path traversal rejected: {rel_path}"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(anyhow!("absolute paths are not allowed: {rel_path}"));
            }
            _ => {}
        }
    }
    let joined = root.join(rel);
    let canonical_root = root
        .canonicalize()
        .with_context(|| format!("failed to canonicalize root {}", root.display()))?;
    let canonical = joined
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", joined.display()))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(anyhow!("path escapes mount root: {rel_path}"));
    }
    Ok(canonical)
}

/// Read a UTF-8 text file, normalizing CRLF → LF.
pub fn read_text_file(path: &Path) -> Result<String> {
    let raw =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    Ok(raw.replace("\r\n", "\n"))
}

/// Write `content` atomically via tmp + rename. Output is always LF.
pub fn atomic_write_text(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create parent {}", parent.display()))?;
    }
    let normalized = content.replace("\r\n", "\n");
    let tmp_path = path.with_extension("md.tmp");
    {
        let mut file = fs::File::create(&tmp_path)
            .with_context(|| format!("failed to create tmp {}", tmp_path.display()))?;
        file.write_all(normalized.as_bytes())
            .with_context(|| format!("failed to write tmp {}", tmp_path.display()))?;
        file.sync_all()
            .with_context(|| format!("failed to sync tmp {}", tmp_path.display()))?;
    }
    fs::rename(&tmp_path, path).with_context(|| {
        format!(
            "failed to rename {} → {}",
            tmp_path.display(),
            path.display()
        )
    })?;
    Ok(())
}

/// File mtime as ISO 8601 UTC string.
pub fn file_mtime_iso(path: &Path) -> Result<String> {
    let meta = fs::metadata(path).with_context(|| format!("failed to stat {}", path.display()))?;
    let modified = meta
        .modified()
        .with_context(|| format!("failed to get mtime for {}", path.display()))?;
    let datetime: chrono::DateTime<chrono::Utc> = modified.into();
    Ok(datetime.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_parent_dir_traversal() {
        let root = std::env::temp_dir().join("grimodex-io-test-root");
        fs::create_dir_all(&root).ok();
        let err = resolve_under_root(&root, "../escape.md").unwrap_err();
        assert!(err.to_string().contains("traversal"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn atomic_write_roundtrip() {
        let dir = std::env::temp_dir().join(format!("grimodex-io-atomic-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.md");
        atomic_write_text(&path, "hello\nworld").unwrap();
        assert_eq!(read_text_file(&path).unwrap(), "hello\nworld");
        fs::remove_dir_all(&dir).ok();
    }
}
