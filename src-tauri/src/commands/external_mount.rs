use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::AppError;
use crate::external_mount::io::{atomic_write_text, file_mtime_iso, read_text_file, resolve_under_root};
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

    {
        let reg = mount_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        for existing in reg.roots.values() {
            if paths_overlap(&existing.path, &path) {
                return Err(anyhow::anyhow!(
                    "mount path overlaps with existing root: {}",
                    existing.label
                )
                .into());
            }
        }
    }

    let scan = scan_root(&root_path)?;

    {
        let mut reg = mount_state
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        reg.roots.insert(
            root_id.clone(),
            RegisteredRoot {
                id: root_id.clone(),
                path: path.clone(),
                label,
            },
        );
    }

    let mut watch_reg = watch_state
        .inner
        .lock()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    watch_reg.register(app, root_id, root_path)?;

    Ok(scan)
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
    let reg = mount_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
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
    let reg = mount_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
    let root = reg
        .roots
        .get(root_id)
        .ok_or_else(|| anyhow::anyhow!("unknown external root: {root_id}"))?;
    Ok(PathBuf::from(&root.path))
}

fn paths_overlap(a: &str, b: &str) -> bool {
    let a = Path::new(a)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(a));
    let b = Path::new(b)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(b));
    a.starts_with(&b) || b.starts_with(&a)
}
