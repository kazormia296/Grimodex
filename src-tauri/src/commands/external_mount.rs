use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::AppError;
use crate::external_mount::io::{
    atomic_write_text, file_mtime_iso, read_text_file, resolve_under_root,
};
use crate::external_mount::path::{self, OverlapError};
use crate::external_mount::scan::{scan_root, ScanResult};
use crate::external_mount::watch::ExternalMountWatchState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredRoot {
    pub id: String,
    pub path: String,
    pub label: String,
}

#[derive(Default)]
pub struct ExternalMountRegistry {
    roots: HashMap<String, RegisteredRoot>,
}

impl ExternalMountRegistry {
    /// Atomically check for overlap against existing roots and insert the new
    /// root. Single `&mut self` borrow keeps the check+insert from racing
    /// against another caller holding the same `MutexGuard`.
    pub fn try_register(
        &mut self,
        root_id: String,
        path: String,
        label: String,
    ) -> anyhow::Result<()> {
        let new_path = Path::new(&path);
        for existing in self.roots.values() {
            match path::overlap_check(new_path, Path::new(&existing.path)) {
                Ok(true) => {
                    anyhow::bail!("mount path overlaps with existing root: {}", existing.label);
                }
                Ok(false) => {}
                Err(OverlapError::NewMissing(e)) => return Err(e),
                Err(OverlapError::ExistingMissing(e)) => {
                    tracing::warn!(
                        "skipping overlap check against missing existing root {}: {e}",
                        existing.label
                    );
                }
            }
        }
        self.roots.insert(
            root_id.clone(),
            RegisteredRoot {
                id: root_id,
                path,
                label,
            },
        );
        Ok(())
    }

    #[cfg(test)]
    pub fn contains(&self, root_id: &str) -> bool {
        self.roots.contains_key(root_id)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.roots.len()
    }
}

pub struct ExternalMountState {
    pub inner: Mutex<ExternalMountRegistry>,
}

impl ExternalMountState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ExternalMountRegistry::default()),
        }
    }
}

#[tauri::command]
pub(crate) fn external_mount_register(
    app: AppHandle,
    watch_state: State<'_, ExternalMountWatchState>,
    mount_state: State<'_, ExternalMountState>,
    root_id: String,
    path: String,
    label: String,
) -> Result<ScanResult, AppError> {
    let root_path = PathBuf::from(&path);
    if !root_path.is_dir() {
        return Err(anyhow::anyhow!("mount path is not a directory: {path}").into());
    }

    // scan_root walks the tree and reads every .md; keep it outside the
    // mount_state lock so concurrent read/write/list/unregister are not
    // blocked. The check+insert below stays atomic because it runs under one
    // MutexGuard.
    let scan = scan_root(&root_path)?;

    register_with_rollback(&mount_state.inner, &root_id, path, label, || {
        let mut watch_reg = watch_state
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        watch_reg.register(app, root_id.clone(), root_path)
    })?;

    Ok(scan)
}

/// Register a root and run a side-effect (typically watcher start) with
/// atomic rollback. If `do_side_effect` errors, the entry inserted by
/// `try_register` is removed so callers don't observe an orphan mount whose
/// reads/writes would resolve but whose change events would never fire.
fn register_with_rollback<F>(
    mount: &Mutex<ExternalMountRegistry>,
    root_id: &str,
    path: String,
    label: String,
    do_side_effect: F,
) -> anyhow::Result<()>
where
    F: FnOnce() -> anyhow::Result<()>,
{
    {
        let mut reg = mount.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        reg.try_register(root_id.to_string(), path, label)?;
    }
    if let Err(e) = do_side_effect() {
        if let Ok(mut reg) = mount.lock() {
            reg.roots.remove(root_id);
        }
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn external_mount_unregister(
    watch_state: State<'_, ExternalMountWatchState>,
    mount_state: State<'_, ExternalMountState>,
    root_id: String,
) -> Result<(), AppError> {
    {
        let mut reg = mount_state
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        reg.roots.remove(&root_id);
    }
    let mut watch_reg = watch_state
        .inner
        .lock()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    watch_reg.unregister(&root_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn external_mount_read_file(
    mount_state: State<'_, ExternalMountState>,
    root_id: String,
    rel_path: String,
) -> Result<String, AppError> {
    let root_path = lookup_root_path(&mount_state, &root_id)?;
    let abs = resolve_under_root(&root_path, &rel_path)?;
    read_text_file(&abs).map_err(AppError::from)
}

#[tauri::command]
pub(crate) fn external_mount_write_file(
    mount_state: State<'_, ExternalMountState>,
    root_id: String,
    rel_path: String,
    content: String,
) -> Result<(), AppError> {
    let root_path = lookup_root_path(&mount_state, &root_id)?;
    let abs = resolve_under_root(&root_path, &rel_path)?;
    atomic_write_text(&abs, &content).map_err(AppError::from)
}

#[tauri::command]
pub(crate) fn external_mount_list(
    mount_state: State<'_, ExternalMountState>,
) -> Result<Vec<RegisteredRoot>, AppError> {
    let reg = mount_state
        .inner
        .lock()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(reg.roots.values().cloned().collect())
}

#[tauri::command]
pub(crate) fn external_mount_file_mtime(
    mount_state: State<'_, ExternalMountState>,
    root_id: String,
    rel_path: String,
) -> Result<String, AppError> {
    let root_path = lookup_root_path(&mount_state, &root_id)?;
    let abs = resolve_under_root(&root_path, &rel_path)?;
    file_mtime_iso(&abs).map_err(AppError::from)
}

#[tauri::command]
pub(crate) fn external_mount_scan(
    mount_state: State<'_, ExternalMountState>,
    root_id: String,
) -> Result<ScanResult, AppError> {
    let root_path = lookup_root_path(&mount_state, &root_id)?;
    scan_root(&root_path).map_err(AppError::from)
}

fn lookup_root_path(
    mount_state: &State<'_, ExternalMountState>,
    root_id: &str,
) -> Result<PathBuf, AppError> {
    let reg = mount_state
        .inner
        .lock()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let root = reg
        .roots
        .get(root_id)
        .ok_or_else(|| anyhow::anyhow!("unknown external root: {root_id}"))?;
    Ok(PathBuf::from(&root.path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "grimodex-mount-reg-{name}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn path_str(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn try_register_inserts_first_root() {
        let dir = temp_dir("first");
        fs::create_dir_all(&dir).unwrap();
        let mut reg = ExternalMountRegistry::default();

        reg.try_register("root-a".into(), path_str(&dir), "A".into())
            .unwrap();
        assert!(reg.contains("root-a"));
        assert_eq!(reg.len(), 1);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn try_register_accepts_non_overlapping_paths() {
        let dir_a = temp_dir("a");
        let dir_b = temp_dir("b");
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();
        let mut reg = ExternalMountRegistry::default();

        reg.try_register("root-a".into(), path_str(&dir_a), "A".into())
            .unwrap();
        reg.try_register("root-b".into(), path_str(&dir_b), "B".into())
            .unwrap();
        assert_eq!(reg.len(), 2);

        fs::remove_dir_all(&dir_a).ok();
        fs::remove_dir_all(&dir_b).ok();
    }

    #[test]
    fn try_register_rejects_parent_of_existing() {
        let parent = temp_dir("parent");
        let child = parent.join("child");
        fs::create_dir_all(&child).unwrap();
        let mut reg = ExternalMountRegistry::default();

        reg.try_register("root-child".into(), path_str(&child), "Child".into())
            .unwrap();
        let err = reg
            .try_register("root-parent".into(), path_str(&parent), "Parent".into())
            .unwrap_err();
        assert!(err.to_string().contains("overlaps"));

        // Atomicity: the failed insert must NOT have mutated the registry.
        assert_eq!(reg.len(), 1);
        assert!(reg.contains("root-child"));
        assert!(!reg.contains("root-parent"));

        fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn try_register_rejects_child_of_existing() {
        let parent = temp_dir("p");
        let child = parent.join("c");
        fs::create_dir_all(&child).unwrap();
        let mut reg = ExternalMountRegistry::default();

        reg.try_register("root-parent".into(), path_str(&parent), "Parent".into())
            .unwrap();
        let err = reg
            .try_register("root-child".into(), path_str(&child), "Child".into())
            .unwrap_err();
        assert!(err.to_string().contains("overlaps"));
        assert_eq!(reg.len(), 1);
        assert!(!reg.contains("root-child"));

        fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn try_register_rejects_same_path() {
        let dir = temp_dir("same");
        fs::create_dir_all(&dir).unwrap();
        let mut reg = ExternalMountRegistry::default();

        reg.try_register("root-a".into(), path_str(&dir), "A".into())
            .unwrap();
        let err = reg
            .try_register("root-b".into(), path_str(&dir), "B".into())
            .unwrap_err();
        assert!(err.to_string().contains("overlaps"));
        assert_eq!(reg.len(), 1);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn try_register_propagates_new_missing_when_overlap_checked() {
        // try_register itself does not validate the new path (the caller's
        // is_dir() check does). But when at least one existing root forces an
        // overlap_check, canonicalize() on a missing new path surfaces as
        // OverlapError::NewMissing — which try_register must propagate (not
        // silently insert).
        let existing = temp_dir("existing");
        let missing = temp_dir("missing-new");
        fs::create_dir_all(&existing).unwrap();
        let mut reg = ExternalMountRegistry::default();

        reg.try_register("root-existing".into(), path_str(&existing), "E".into())
            .unwrap();

        let err = reg
            .try_register("root-missing".into(), path_str(&missing), "M".into())
            .unwrap_err();
        assert!(
            err.to_string().contains("canonicalize")
                || err.to_string().contains("No such file")
                || err.to_string().contains("cannot find"),
            "unexpected error: {err}"
        );
        // Atomicity: the failed insert must NOT have mutated the registry.
        assert_eq!(reg.len(), 1);
        assert!(!reg.contains("root-missing"));

        fs::remove_dir_all(&existing).ok();
    }

    #[test]
    fn register_with_rollback_keeps_root_on_side_effect_ok() {
        let dir = temp_dir("rb-ok");
        fs::create_dir_all(&dir).unwrap();
        let mount = Mutex::new(ExternalMountRegistry::default());

        register_with_rollback(&mount, "root", path_str(&dir), "L".into(), || Ok(())).unwrap();

        let reg = mount.lock().unwrap();
        assert!(reg.contains("root"));
        assert_eq!(reg.len(), 1);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn register_with_rollback_removes_root_on_side_effect_err() {
        // Mirrors the orphan-mount scenario: try_register succeeds, but the
        // watcher (modeled here by the closure) fails. The rollback must
        // leave the registry empty so a subsequent read/write does not
        // resolve a path with no watcher attached.
        let dir = temp_dir("rb-err");
        fs::create_dir_all(&dir).unwrap();
        let mount = Mutex::new(ExternalMountRegistry::default());

        let err = register_with_rollback(&mount, "root", path_str(&dir), "L".into(), || {
            anyhow::bail!("watcher boom")
        })
        .unwrap_err();
        assert!(err.to_string().contains("watcher boom"));

        let reg = mount.lock().unwrap();
        assert_eq!(reg.len(), 0);
        assert!(!reg.contains("root"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn register_with_rollback_skips_side_effect_when_try_register_fails() {
        // If try_register rejects (e.g. overlapping path), the side effect
        // must NOT run — otherwise a watcher could be started for a root we
        // never registered.
        let dir = temp_dir("rb-overlap");
        fs::create_dir_all(&dir).unwrap();
        let mount = Mutex::new(ExternalMountRegistry::default());
        register_with_rollback(&mount, "root-a", path_str(&dir), "A".into(), || Ok(())).unwrap();

        let side_effect_called = std::sync::atomic::AtomicBool::new(false);
        let err = register_with_rollback(&mount, "root-b", path_str(&dir), "B".into(), || {
            side_effect_called.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err();
        assert!(err.to_string().contains("overlaps"));
        assert!(!side_effect_called.load(std::sync::atomic::Ordering::SeqCst));

        let reg = mount.lock().unwrap();
        assert_eq!(reg.len(), 1);
        assert!(reg.contains("root-a"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn try_register_skips_missing_existing_and_accepts_new() {
        // If an already-registered root no longer exists on disk, overlap_check
        // returns ExistingMissing; try_register must log+skip and still accept
        // the new (non-overlapping) registration.
        let gone = temp_dir("gone");
        let live = temp_dir("live");
        fs::create_dir_all(&gone).unwrap();
        fs::create_dir_all(&live).unwrap();
        let mut reg = ExternalMountRegistry::default();

        reg.try_register("root-gone".into(), path_str(&gone), "Gone".into())
            .unwrap();
        fs::remove_dir_all(&gone).unwrap();

        reg.try_register("root-live".into(), path_str(&live), "Live".into())
            .unwrap();
        assert!(reg.contains("root-live"));
        assert_eq!(reg.len(), 2);

        fs::remove_dir_all(&live).ok();
    }
}
