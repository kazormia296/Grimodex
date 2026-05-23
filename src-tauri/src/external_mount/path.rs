use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

/// Normalize a relative path for storage / IPC (forward slashes).
pub fn normalize_rel_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Canonicalize a mount root once at registration / scan time.
pub fn canonicalize_mount_root(root: &Path) -> Result<PathBuf> {
    root.canonicalize()
        .with_context(|| format!("failed to canonicalize mount root {}", root.display()))
}

/// Compute a relative path under `canonical_root` for watch events.
/// Works when `event_path` no longer exists (delete / rename old side).
pub fn rel_path_under_root(canonical_root: &Path, event_path: &Path) -> Result<String> {
    if !event_path.is_absolute() {
        return Ok(normalize_rel_path(event_path));
    }

    if let Ok(canonical) = event_path.canonicalize() {
        return rel_path_from_canonical(canonical_root, &canonical);
    }

    rel_path_from_simplified(canonical_root, event_path)
}

/// Strip `canonical_root` from an already-canonical absolute `path` (scan walk).
pub fn rel_path_from_canonical(canonical_root: &Path, path: &Path) -> Result<String> {
    let rel = path.strip_prefix(canonical_root).with_context(|| {
        format!(
            "{} is not under {}",
            path.display(),
            canonical_root.display()
        )
    })?;
    Ok(normalize_rel_path(rel))
}

#[derive(Debug)]
pub enum OverlapError {
    NewMissing(anyhow::Error),
    ExistingMissing(anyhow::Error),
}

/// Check whether `new_path` overlaps `existing_path` (either contains the other).
pub fn overlap_check(new_path: &Path, existing_path: &Path) -> Result<bool, OverlapError> {
    let new_canon = new_path.canonicalize().map_err(|e| {
        OverlapError::NewMissing(
            anyhow::Error::from(e)
                .context(format!("failed to canonicalize new mount path {}", new_path.display())),
        )
    })?;
    let existing_canon = existing_path
        .canonicalize()
        .map_err(|e| OverlapError::ExistingMissing(anyhow::Error::from(e)))?;

    Ok(one_contains_other(&new_canon, &existing_canon)
        || one_contains_other(&existing_canon, &new_canon))
}

/// True when `child` equals `parent` or is a strict subdirectory of `parent`.
pub fn one_contains_other(parent: &Path, child: &Path) -> bool {
    if parent == child {
        return true;
    }
    path_starts_with(child, parent) && strip_path_prefix(child, parent).is_ok()
}

fn rel_path_from_simplified(canonical_root: &Path, event_path: &Path) -> Result<String> {
    let root = simplify_path(canonical_root);
    let candidate = simplify_path(event_path);

    if path_starts_with(&candidate, &root) {
        let rest = strip_path_prefix(&candidate, &root)?;
        return Ok(normalize_rel_path(&rest));
    }

    Err(anyhow!(
        "{} is not under {}",
        event_path.display(),
        canonical_root.display()
    ))
}

/// Remove Windows extended-length prefixes (`\\?\`, `\\?\UNC\`).
fn simplify_path(path: &Path) -> PathBuf {
    PathBuf::from(strip_extended_prefix(&path.to_string_lossy()))
}

fn strip_extended_prefix(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.to_string()
    }
}

fn path_starts_with(path: &Path, prefix: &Path) -> bool {
    let path_s = path.as_os_str().len();
    let prefix_s = prefix.as_os_str().len();
    if path_s < prefix_s {
        return false;
    }

    #[cfg(windows)]
    {
        let path_str = path.to_string_lossy();
        let prefix_str = prefix.to_string_lossy();
        if path_str.len() < prefix_str.len() {
            return false;
        }
        if !path_str[..prefix_str.len()].eq_ignore_ascii_case(&prefix_str) {
            return false;
        }
        if path_str.len() == prefix_str.len() {
            return true;
        }
        let next = path_str.as_bytes()[prefix_str.len()];
        return next == b'\\' || next == b'/';
    }

    #[cfg(not(windows))]
    {
        path.starts_with(prefix)
    }
}

fn strip_path_prefix(path: &Path, prefix: &Path) -> Result<PathBuf> {
    if !path_starts_with(path, prefix) {
        return Err(anyhow!(
            "{} is not a prefix of {}",
            prefix.display(),
            path.display()
        ));
    }

    #[cfg(windows)]
    {
        let path_str = path.to_string_lossy();
        let prefix_str = prefix.to_string_lossy();
        let mut rest = path_str[prefix_str.len()..].to_string();
        if let Some(stripped) = rest.strip_prefix('\\') {
            rest = stripped.to_string();
        } else if let Some(stripped) = rest.strip_prefix('/') {
            rest = stripped.to_string();
        }
        return Ok(PathBuf::from(rest));
    }

    #[cfg(not(windows))]
    {
        path.strip_prefix(prefix)
            .map(PathBuf::from)
            .map_err(|_| anyhow!("strip_prefix failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("grimodex-path-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn strip_extended_prefix_cases() {
        assert_eq!(
            strip_extended_prefix(r"\\?\C:\foo\bar"),
            r"C:\foo\bar"
        );
        assert_eq!(
            strip_extended_prefix(r"\\?\UNC\server\share\foo"),
            r"\\server\share\foo"
        );
        assert_eq!(strip_extended_prefix(r"C:\foo\bar"), r"C:\foo\bar");
        assert_eq!(
            strip_extended_prefix(r"\\server\share\foo"),
            r"\\server\share\foo"
        );
    }

    #[test]
    fn one_contains_other_boundary() {
        let foo = PathBuf::from("/tmp/foo");
        let foobar = PathBuf::from("/tmp/foobar");
        assert!(one_contains_other(&foo, &foo));
        assert!(!one_contains_other(&foo, &foobar));
        assert!(!one_contains_other(&foobar, &foo));
    }

    #[test]
    fn one_contains_other_nested() {
        let parent = PathBuf::from("/tmp/parent");
        let child = PathBuf::from("/tmp/parent/chapter/01.md");
        assert!(one_contains_other(&parent, &child));
        assert!(!one_contains_other(&child, &parent));
    }

    #[test]
    fn overlap_check_same_and_nested() {
        let root = temp_dir("overlap");
        fs::create_dir_all(root.join("sub")).unwrap();
        let sub = root.join("sub");

        assert!(overlap_check(&root, &root).unwrap());
        assert!(overlap_check(&root, &sub).unwrap());
        assert!(overlap_check(&sub, &root).unwrap());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn overlap_check_prefix_boundary() {
        let foo = temp_dir("foo");
        let foobar = temp_dir("foobar");
        fs::create_dir_all(&foo).unwrap();
        fs::create_dir_all(&foobar).unwrap();

        assert!(!overlap_check(&foo, &foobar).unwrap());

        fs::remove_dir_all(&foo).ok();
        fs::remove_dir_all(&foobar).ok();
    }

    #[test]
    fn overlap_check_new_missing_returns_err() {
        let missing = temp_dir("missing");
        let existing = temp_dir("existing");
        fs::create_dir_all(&existing).unwrap();

        let err = overlap_check(&missing, &existing).unwrap_err();
        assert!(matches!(err, OverlapError::NewMissing(_)));

        fs::remove_dir_all(&existing).ok();
    }

    #[test]
    fn overlap_check_existing_missing_returns_err() {
        let new_root = temp_dir("new");
        let missing = temp_dir("missing");
        fs::create_dir_all(&new_root).unwrap();

        let err = overlap_check(&new_root, &missing).unwrap_err();
        assert!(matches!(err, OverlapError::ExistingMissing(_)));

        fs::remove_dir_all(&new_root).ok();
    }

    #[test]
    fn rel_path_existing_file() {
        let root = temp_dir("rel-existing");
        fs::create_dir_all(root.join("chapter")).unwrap();
        let file = root.join("chapter/01.md");
        fs::write(&file, "# hi").unwrap();

        let canonical_root = canonicalize_mount_root(&root).unwrap();
        let rel = rel_path_under_root(&canonical_root, &file).unwrap();
        assert_eq!(rel, "chapter/01.md");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rel_path_after_delete() {
        let root = temp_dir("rel-delete");
        fs::create_dir_all(root.join("chapter")).unwrap();
        let file = root.join("chapter/01.md");
        fs::write(&file, "# hi").unwrap();

        let canonical_root = canonicalize_mount_root(&root).unwrap();
        let path_for_event = file.clone();
        fs::remove_file(&file).unwrap();

        let rel = rel_path_under_root(&canonical_root, &path_for_event).unwrap();
        assert_eq!(rel, "chapter/01.md");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rel_path_after_rename_old_side() {
        let root = temp_dir("rel-rename");
        fs::create_dir_all(root.join("chapter")).unwrap();
        let old_file = root.join("chapter/old-name.md");
        fs::write(&old_file, "# hi").unwrap();
        let old_path_for_event = old_file.clone();
        let new_file = root.join("chapter/new-name.md");
        fs::rename(&old_file, &new_file).unwrap();

        let canonical_root = canonicalize_mount_root(&root).unwrap();
        let rel = rel_path_under_root(&canonical_root, &old_path_for_event).unwrap();
        assert_eq!(rel, "chapter/old-name.md");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rel_path_windows_extended_prefix() {
        let root_str = strip_extended_prefix(r"\\?\C:\mount\root");
        let file_str = strip_extended_prefix(r"\\?\C:\mount\root\chapter\01.md");
        assert!(file_str.starts_with(&root_str));
        let rest = file_str.strip_prefix(&root_str).unwrap();
        let rest = rest.strip_prefix('\\').or_else(|| rest.strip_prefix('/')).unwrap_or(rest);
        assert_eq!(rest.replace('\\', "/"), "chapter/01.md");
    }

    #[test]
    fn rel_path_windows_unc_extended_prefix() {
        let root_str = strip_extended_prefix(r"\\?\UNC\server\share\notes");
        let file_str = strip_extended_prefix(r"\\?\UNC\server\share\notes\doc.md");
        assert!(file_str.starts_with(&root_str));
        let rest = file_str.strip_prefix(&root_str).unwrap();
        let rest = rest.strip_prefix('\\').or_else(|| rest.strip_prefix('/')).unwrap_or(rest);
        assert_eq!(rest.replace('\\', "/"), "doc.md");
    }

    #[cfg(unix)]
    #[test]
    fn overlap_check_symlink() {
        use std::os::unix::fs::symlink;

        let real = temp_dir("real");
        let link = temp_dir("link");
        fs::create_dir_all(real.join("sub")).unwrap();
        symlink(&real, &link).unwrap();

        assert!(overlap_check(&link.join("sub"), &real).unwrap());

        fs::remove_dir_all(&real).ok();
        fs::remove_dir_all(&link).ok();
    }
}
