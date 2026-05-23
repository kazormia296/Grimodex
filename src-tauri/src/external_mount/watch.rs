use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use super::path::{canonicalize_mount_root, rel_path_under_root};

const DEBOUNCE_MS: u64 = 500;

#[derive(Debug, Clone)]
struct FileEventPayload {
    root_id: String,
    rel_path: String,
    kind: String,
    old_rel_path: Option<String>,
}

struct PendingBatch {
    events: Vec<FileEventPayload>,
    deadline: Instant,
}

pub struct WatchRegistry {
    watchers: HashMap<String, WatcherHandle>,
    pending: HashMap<String, PendingBatch>,
}

struct WatcherHandle {
    #[allow(dead_code)]
    watcher: RecommendedWatcher,
}

impl WatchRegistry {
    pub fn new() -> Self {
        Self {
            watchers: HashMap::new(),
            pending: HashMap::new(),
        }
    }

    pub fn register(
        &mut self,
        app: AppHandle,
        root_id: String,
        root_path: PathBuf,
    ) -> Result<()> {
        self.unregister(&root_id);

        let canonical_root = canonicalize_mount_root(&root_path)?;

        let (tx, mut rx) = mpsc::unbounded_channel::<notify::Result<Event>>();

        let mut watcher = RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            Config::default(),
        )
        .context("failed to create file watcher")?;

        watcher
            .watch(&root_path, RecursiveMode::Recursive)
            .with_context(|| format!("failed to watch {}", root_path.display()))?;

        let app_for_cb = app.clone();
        let root_id_for_cb = root_id.clone();
        let canonical_root_for_cb = canonical_root.clone();
        let registry = app.state::<ExternalMountWatchState>().inner.clone();

        tauri::async_runtime::spawn(async move {
            while let Some(res) = rx.recv().await {
                match res {
                    Ok(event) => {
                        if let Err(e) = handle_notify_event(
                            &app_for_cb,
                            &registry,
                            &root_id_for_cb,
                            &canonical_root_for_cb,
                            event,
                        ) {
                            tracing::warn!("external mount watcher error: {e}");
                        }
                    }
                    Err(e) => tracing::warn!("external mount notify error: {e}"),
                }
            }
        });

        self.watchers.insert(root_id, WatcherHandle { watcher });
        Ok(())
    }

    pub fn unregister(&mut self, root_id: &str) {
        self.watchers.remove(root_id);
        self.pending.remove(root_id);
    }

    fn queue_event(&mut self, app: &AppHandle, root_id: &str, event: FileEventPayload) {
        let now = Instant::now();
        let batch = self.pending.entry(root_id.to_string()).or_insert(PendingBatch {
            events: Vec::new(),
            deadline: now + Duration::from_millis(DEBOUNCE_MS),
        });
        batch.events.push(event);
        batch.deadline = now + Duration::from_millis(DEBOUNCE_MS);

        let app = app.clone();
        let root_id = root_id.to_string();
        let registry = app.state::<ExternalMountWatchState>().inner.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
            if let Ok(mut reg) = registry.lock() {
                reg.flush_if_ready(&app, &root_id);
            }
        });
    }

    fn flush_if_ready(&mut self, app: &AppHandle, root_id: &str) {
        let Some(batch) = self.pending.get(root_id) else {
            return;
        };
        if batch.deadline > Instant::now() {
            return;
        }
        let events = self
            .pending
            .remove(root_id)
            .map(|b| b.events)
            .unwrap_or_default();
        for event in events {
            let channel = match event.kind.as_str() {
                "changed" => "external-mount://file-changed",
                "added" => "external-mount://file-added",
                "removed" => "external-mount://file-removed",
                "renamed" => "external-mount://file-renamed",
                _ => continue,
            };
            let payload = serde_json::json!({
                "rootId": event.root_id,
                "relPath": event.rel_path,
                "oldRelPath": event.old_rel_path,
            });
            let _ = app.emit(channel, payload);
        }
    }
}

pub struct ExternalMountWatchState {
    pub inner: Arc<Mutex<WatchRegistry>>,
}

impl ExternalMountWatchState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(WatchRegistry::new())),
        }
    }
}

fn handle_notify_event(
    app: &AppHandle,
    registry: &Arc<Mutex<WatchRegistry>>,
    root_id: &str,
    canonical_root: &Path,
    event: Event,
) -> Result<()> {
    if matches!(
        event.kind,
        EventKind::Modify(ModifyKind::Name(RenameMode::Any)) | EventKind::Modify(ModifyKind::Name(RenameMode::Both)
        )
    ) && event.paths.len() >= 2
    {
        let old_rel = rel_path_under_root(canonical_root, &event.paths[0])?;
        let new_rel = rel_path_under_root(canonical_root, &event.paths[1])?;
        let payload = FileEventPayload {
            root_id: root_id.to_string(),
            rel_path: new_rel,
            kind: "renamed".to_string(),
            old_rel_path: Some(old_rel),
        };
        if let Ok(mut reg) = registry.lock() {
            reg.queue_event(app, root_id, payload);
        }
        return Ok(());
    }

    for path in &event.paths {
        if !should_track_path(path) {
            continue;
        }
        let rel_path = rel_path_under_root(canonical_root, path)?;
        let payload = match event.kind {
            EventKind::Modify(ModifyKind::Data(_)) | EventKind::Modify(ModifyKind::Any) => {
                FileEventPayload {
                    root_id: root_id.to_string(),
                    rel_path,
                    kind: "changed".to_string(),
                    old_rel_path: None,
                }
            }
            EventKind::Create(CreateKind::File) | EventKind::Create(CreateKind::Any) => {
                FileEventPayload {
                    root_id: root_id.to_string(),
                    rel_path,
                    kind: "added".to_string(),
                    old_rel_path: None,
                }
            }
            EventKind::Remove(RemoveKind::File) | EventKind::Remove(RemoveKind::Any) => {
                FileEventPayload {
                    root_id: root_id.to_string(),
                    rel_path,
                    kind: "removed".to_string(),
                    old_rel_path: None,
                }
            }
            _ => continue,
        };
        if let Ok(mut reg) = registry.lock() {
            reg.queue_event(app, root_id, payload);
        }
    }
    Ok(())
}

fn should_track_path(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("md") || path.is_dir()
}
