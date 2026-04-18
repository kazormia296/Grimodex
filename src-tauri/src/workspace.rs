use serde::{Deserialize, Serialize};
use std::path::Path;

/// Metadata stored inside each workspace at `.grimodex/workspace.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceMeta {
    pub id: String,
    pub created_at: String,
}

/// A single entry in the recent-workspaces list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspace {
    pub path: String,
    pub last_opened: String,
}

/// Application-wide settings persisted in AppData.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettings {
    pub recent_workspaces: Vec<RecentWorkspace>,
    pub last_active_workspace: Option<String>,
    pub theme: String,
    pub ui_language: String,
    pub ui_scale: u32,
    pub show_launcher_on_startup: bool,
    /// Dockview layout serialization (project-independent UI state).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<serde_json::Value>,
    /// User-saved layout presets (array of {id, name, layout} objects).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout_presets: Option<serde_json::Value>,
    /// ID of the last-applied layout preset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_layout_preset_id: Option<String>,
    /// Named color theme (e.g. "dark-academia"). None = default theme.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_theme: Option<String>,
    /// Workspace paths the user has explicitly trusted.
    #[serde(default)]
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub trusted_workspaces: Vec<String>,
    /// Whether the user has already seen the welcome tour.
    #[serde(default)]
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub has_seen_welcome: bool,
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self {
            recent_workspaces: Vec::new(),
            last_active_workspace: None,
            theme: "system".to_string(),
            ui_language: "ja".to_string(),
            ui_scale: 100,
            show_launcher_on_startup: false,
            layout: None,
            layout_presets: None,
            active_layout_preset_id: None,
            color_theme: None,
            trusted_workspaces: Vec::new(),
            has_seen_welcome: false,
        }
    }
}

/// Read global settings from the given file path.
/// Returns default settings if the file does not exist or is invalid.
pub fn read_global_settings(path: &Path) -> GlobalSettings {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => GlobalSettings::default(),
    }
}

/// Write global settings to the given file path.
pub fn write_global_settings(path: &Path, settings: &GlobalSettings) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(settings)?;
    std::fs::write(path, json)?;
    Ok(())
}

/// Check whether a given directory is (or can be) a valid workspace.
/// Returns `true` if the directory exists and either:
/// - contains `grimodex.db` (existing workspace), or
/// - is empty or does not exist yet (new workspace).
#[allow(dead_code)]
pub fn is_valid_workspace_path(path: &Path) -> bool {
    if !path.exists() {
        return true; // Will be created
    }
    if !path.is_dir() {
        return false;
    }
    if path.join("grimodex.db").exists() {
        return true;
    }
    // Empty directory is valid
    match std::fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => false,
    }
}

/// Check if a path contains an existing workspace (has grimodex.db).
pub fn is_existing_workspace(path: &Path) -> bool {
    path.join("grimodex.db").exists()
}

/// Initialize workspace metadata in `.grimodex/workspace.json`.
/// If metadata already exists, reads and returns it.
/// Otherwise, creates new metadata with the given UUID and timestamp.
pub fn ensure_workspace_meta(
    workspace_path: &Path,
    uuid_str: &str,
    now: &str,
) -> anyhow::Result<WorkspaceMeta> {
    let meta_dir = workspace_path.join(".grimodex");
    let meta_path = meta_dir.join("workspace.json");

    if meta_path.exists() {
        let content = std::fs::read_to_string(&meta_path)?;
        let meta: WorkspaceMeta = serde_json::from_str(&content)?;
        return Ok(meta);
    }

    std::fs::create_dir_all(&meta_dir)?;
    let meta = WorkspaceMeta {
        id: uuid_str.to_string(),
        created_at: now.to_string(),
    };
    let json = serde_json::to_string_pretty(&meta)?;
    std::fs::write(&meta_path, json)?;
    Ok(meta)
}

/// Register (or update) a workspace in the recent-workspaces list.
pub fn touch_recent_workspace(settings: &mut GlobalSettings, workspace_path: &str, now: &str) {
    // Remove existing entry for this path (if any)
    settings
        .recent_workspaces
        .retain(|w| w.path != workspace_path);

    // Insert at front
    settings.recent_workspaces.insert(
        0,
        RecentWorkspace {
            path: workspace_path.to_string(),
            last_opened: now.to_string(),
        },
    );

    // Keep max 10 entries
    settings.recent_workspaces.truncate(10);

    settings.last_active_workspace = Some(workspace_path.to_string());
}

/// Extract the folder name from a workspace path.
pub fn workspace_name(path: &str) -> String {
    // Handle both Unix (/) and Windows (\) separators regardless of host OS
    path.rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("grimodex_ws_test_{name}"))
    }

    fn cleanup(dir: &Path) {
        fs::remove_dir_all(dir).ok();
    }

    // --- GlobalSettings ---

    #[test]
    fn test_read_global_settings_missing_file_returns_default() {
        let dir = temp_dir("gs_missing");
        cleanup(&dir);
        let path = dir.join("settings.json");
        let settings = read_global_settings(&path);
        assert!(settings.recent_workspaces.is_empty());
        assert_eq!(settings.theme, "system");
        assert!(!settings.show_launcher_on_startup);
        assert!(settings.last_active_workspace.is_none());
    }

    #[test]
    fn test_write_and_read_global_settings_roundtrip() {
        let dir = temp_dir("gs_roundtrip");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        let path = dir.join("settings.json");

        let settings = GlobalSettings {
            theme: "dark".to_string(),
            recent_workspaces: vec![RecentWorkspace {
                path: "D:\\Novels\\MyNovel".to_string(),
                last_opened: "2026-03-30T12:00:00Z".to_string(),
            }],
            last_active_workspace: Some("D:\\Novels\\MyNovel".to_string()),
            ..GlobalSettings::default()
        };

        write_global_settings(&path, &settings).expect("write");
        let loaded = read_global_settings(&path);

        assert_eq!(loaded.theme, "dark");
        assert_eq!(loaded.recent_workspaces.len(), 1);
        assert_eq!(loaded.recent_workspaces[0].path, "D:\\Novels\\MyNovel");
        assert_eq!(
            loaded.last_active_workspace,
            Some("D:\\Novels\\MyNovel".to_string())
        );

        cleanup(&dir);
    }

    #[test]
    fn test_read_global_settings_invalid_json_returns_default() {
        let dir = temp_dir("gs_invalid");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        let path = dir.join("settings.json");
        fs::write(&path, "not json").expect("write garbage");

        let settings = read_global_settings(&path);
        assert!(settings.recent_workspaces.is_empty());
        assert_eq!(settings.theme, "system");

        cleanup(&dir);
    }

    // --- is_valid_workspace_path ---

    #[test]
    fn test_valid_workspace_nonexistent_path() {
        let dir = temp_dir("ws_nonexist");
        cleanup(&dir);
        assert!(is_valid_workspace_path(&dir));
    }

    #[test]
    fn test_valid_workspace_empty_dir() {
        let dir = temp_dir("ws_empty");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        assert!(is_valid_workspace_path(&dir));
        cleanup(&dir);
    }

    #[test]
    fn test_valid_workspace_existing_workspace() {
        let dir = temp_dir("ws_existing");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        fs::write(dir.join("grimodex.db"), "fake db").ok();
        assert!(is_valid_workspace_path(&dir));
        cleanup(&dir);
    }

    #[test]
    fn test_invalid_workspace_nonempty_dir_without_db() {
        let dir = temp_dir("ws_nonempty");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        fs::write(dir.join("random.txt"), "stuff").ok();
        assert!(!is_valid_workspace_path(&dir));
        cleanup(&dir);
    }

    #[test]
    fn test_invalid_workspace_file_not_dir() {
        let dir = temp_dir("ws_file");
        cleanup(&dir);
        if let Some(parent) = dir.parent() {
            fs::create_dir_all(parent).ok();
        }
        fs::write(&dir, "I am a file").ok();
        assert!(!is_valid_workspace_path(&dir));
        cleanup(&dir);
    }

    // --- is_existing_workspace ---

    #[test]
    fn test_is_existing_workspace_with_db() {
        let dir = temp_dir("ws_has_db");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        fs::write(dir.join("grimodex.db"), "fake").ok();
        assert!(is_existing_workspace(&dir));
        cleanup(&dir);
    }

    #[test]
    fn test_is_existing_workspace_without_db() {
        let dir = temp_dir("ws_no_db");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        assert!(!is_existing_workspace(&dir));
        cleanup(&dir);
    }

    // --- ensure_workspace_meta ---

    #[test]
    fn test_ensure_workspace_meta_creates_new() {
        let dir = temp_dir("ws_meta_new");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();

        let meta =
            ensure_workspace_meta(&dir, "test-uuid-1234", "2026-03-31T00:00:00Z").expect("create");
        assert_eq!(meta.id, "test-uuid-1234");
        assert_eq!(meta.created_at, "2026-03-31T00:00:00Z");

        let meta_path = dir.join(".grimodex").join("workspace.json");
        assert!(meta_path.exists());

        cleanup(&dir);
    }

    #[test]
    fn test_ensure_workspace_meta_reads_existing() {
        let dir = temp_dir("ws_meta_existing");
        cleanup(&dir);
        let meta_dir = dir.join(".grimodex");
        fs::create_dir_all(&meta_dir).ok();

        let existing = WorkspaceMeta {
            id: "existing-uuid".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
        };
        fs::write(
            meta_dir.join("workspace.json"),
            serde_json::to_string(&existing).unwrap(),
        )
        .ok();

        let meta =
            ensure_workspace_meta(&dir, "new-uuid-ignored", "2026-03-31T00:00:00Z").expect("read");
        assert_eq!(meta.id, "existing-uuid");
        assert_eq!(meta.created_at, "2026-01-01T00:00:00Z");

        cleanup(&dir);
    }

    // --- touch_recent_workspace ---

    #[test]
    fn test_touch_recent_workspace_adds_new() {
        let mut settings = GlobalSettings::default();
        touch_recent_workspace(&mut settings, "D:\\Novels\\New", "2026-03-31T00:00:00Z");

        assert_eq!(settings.recent_workspaces.len(), 1);
        assert_eq!(settings.recent_workspaces[0].path, "D:\\Novels\\New");
        assert_eq!(
            settings.last_active_workspace,
            Some("D:\\Novels\\New".to_string())
        );
    }

    #[test]
    fn test_touch_recent_workspace_moves_existing_to_front() {
        let mut settings = GlobalSettings::default();
        touch_recent_workspace(&mut settings, "D:\\A", "2026-03-31T00:00:00Z");
        touch_recent_workspace(&mut settings, "D:\\B", "2026-03-31T01:00:00Z");
        touch_recent_workspace(&mut settings, "D:\\A", "2026-03-31T02:00:00Z");

        assert_eq!(settings.recent_workspaces.len(), 2);
        assert_eq!(settings.recent_workspaces[0].path, "D:\\A");
        assert_eq!(settings.recent_workspaces[1].path, "D:\\B");
    }

    #[test]
    fn test_touch_recent_workspace_truncates_to_10() {
        let mut settings = GlobalSettings::default();
        for i in 0..15 {
            touch_recent_workspace(
                &mut settings,
                &format!("D:\\Workspace{i}"),
                "2026-03-31T00:00:00Z",
            );
        }
        assert_eq!(settings.recent_workspaces.len(), 10);
        assert_eq!(settings.recent_workspaces[0].path, "D:\\Workspace14");
    }

    // --- workspace_name ---

    #[test]
    fn test_workspace_name_extracts_folder_name() {
        assert_eq!(workspace_name("D:\\Novels\\MyNovel"), "MyNovel");
        assert_eq!(workspace_name("/home/user/novels/scifi"), "scifi");
    }

    #[test]
    fn test_workspace_name_root_path() {
        let name = workspace_name("/");
        assert!(!name.is_empty());
    }
}
