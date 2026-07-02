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
    /// User overrides for built-in layout presets (map of builtin id → snapshot).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub builtin_layout_preset_overrides: Option<serde_json::Value>,
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
    /// Version of the EULA the user has accepted (e.g. "1.0").
    /// None = never accepted; modal will be shown on launch.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_eula_version: Option<String>,
    /// Timeline panel settings (zoom, axis mode, scroll offset, etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline: Option<serde_json::Value>,
    /// Map panel settings (mode, viewport, show flags, etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map: Option<serde_json::Value>,
    /// Grid panel display settings (showSynopsis, showBeats, etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid: Option<serde_json::Value>,
    /// Matrix panel settings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matrix: Option<serde_json::Value>,
    /// Chronicle (作中年表) panel settings (zoom, pan/zoom view, showOffpage, locked).
    /// フロント側は camelCase `chronicle` として read-modify-write する
    /// (chronicleStore.ts)。ここに宣言が無いと serde が silent drop し、
    /// 年表ビューの永続化が成立しない (round-trip 欠落)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chronicle: Option<serde_json::Value>,
    /// Layout schema version (PersistedLayout migration marker).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout_version: Option<u32>,
    /// Per-panel tool window state (slot / view mode / undock size).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_windows: Option<serde_json::Value>,
    /// Panel ids that keep a stripe icon across close.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stripe_panel_ids: Option<serde_json::Value>,
    /// Stripe (left/right/bottom) widths in px.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stripe_sizes: Option<serde_json::Value>,
    /// Stripe visibility per region.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stripe_visibility: Option<serde_json::Value>,
    /// User-preference settings (cross-workspace): editor visuals, keys, display, data, revision.
    /// Keyed by the same key strings used in app_settings (e.g. "editor.fontFamily").
    #[serde(default)]
    #[serde(skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub user_preferences: std::collections::HashMap<String, String>,
    /// Default values applied to new projects/workspaces on creation.
    /// Keyed by the same key strings as user_preferences; covers work-specific settings
    /// (tree.*, export.*, beat.*, editor.targetCharCount, ai.contextBudget.*, etc.).
    #[serde(default)]
    #[serde(skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub project_defaults: std::collections::HashMap<String, String>,
    /// Default AI policy preset applied to new projects.
    /// Serialized as a JSON string matching the AiPolicy TS type.
    /// None = fall back to the full preset default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_ai_policy: Option<String>,
    /// Path to the sample workspace created during onboarding.
    /// Used to re-open or re-seed the sample for the "Restart Tutorial" flow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_workspace_path: Option<String>,
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
            builtin_layout_preset_overrides: None,
            active_layout_preset_id: None,
            color_theme: None,
            trusted_workspaces: Vec::new(),
            has_seen_welcome: false,
            accepted_eula_version: None,
            timeline: None,
            map: None,
            grid: None,
            matrix: None,
            chronicle: None,
            layout_version: None,
            tool_windows: None,
            stripe_panel_ids: None,
            stripe_sizes: None,
            stripe_visibility: None,
            user_preferences: std::collections::HashMap::new(),
            project_defaults: std::collections::HashMap::new(),
            default_ai_policy: None,
            sample_workspace_path: None,
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
///
/// 同一ディレクトリの `.tmp` に書いてから rename で原子的に置き換える。
/// DB コマンドの async 化 (M3) で blocking pool 上の open_workspace /
/// seed_sample_workspace と main thread の save_global_settings が並行しうる
/// ため、素の `fs::write` だと torn read (部分書き込みの読取り → default への
/// 巻き戻り永続化) が起きる。rename は Unix では原子的置換、Windows でも
/// 既存宛先を置換する (`MOVEFILE_REPLACE_EXISTING`)。呼び出し側の
/// read-modify-write 直列化は `GlobalSettingsPath::write_lock` が担う。
pub fn write_global_settings(path: &Path, settings: &GlobalSettings) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(settings)?;
    let mut tmp_os = path.as_os_str().to_owned();
    tmp_os.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp_os);
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
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
    fn test_write_global_settings_atomic_tmp_renamed_away() {
        let dir = temp_dir("gs_atomic");
        cleanup(&dir);
        let path = dir.join("settings.json");
        let tmp = {
            let mut os = path.as_os_str().to_owned();
            os.push(".tmp");
            PathBuf::from(os)
        };

        let settings = GlobalSettings {
            theme: "dark".to_string(),
            ..GlobalSettings::default()
        };
        write_global_settings(&path, &settings).expect("write");

        // .tmp は rename で消えている (torn read 対策の atomic 置換)。
        assert!(!tmp.exists(), ".tmp must be renamed away after write");
        assert_eq!(read_global_settings(&path).theme, "dark");

        // 既存宛先があっても rename で置換できる (2 回目以降の write)。
        let settings2 = GlobalSettings {
            theme: "light".to_string(),
            ..GlobalSettings::default()
        };
        write_global_settings(&path, &settings2).expect("overwrite");
        assert!(!tmp.exists(), ".tmp must be renamed away after overwrite");
        assert_eq!(read_global_settings(&path).theme, "light");
        cleanup(&dir);
    }

    #[test]
    fn test_global_settings_preserves_timeline_field() {
        let dir = temp_dir("gs_timeline");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        let path = dir.join("settings.json");

        let timeline_json = serde_json::json!({
            "axisMode": "story",
            "spacingMode": "proportional",
            "zoom": 2.0,
            "scrollOffset": 120,
            "display": {
                "showTitles": false,
                "showChapterNumbers": true,
                "showPhasePins": true
            }
        });

        let settings = GlobalSettings {
            timeline: Some(timeline_json.clone()),
            ..GlobalSettings::default()
        };

        write_global_settings(&path, &settings).expect("write");
        let loaded = read_global_settings(&path);

        assert!(
            loaded.timeline.is_some(),
            "timeline field must survive roundtrip"
        );
        let tl = loaded.timeline.unwrap();
        assert_eq!(tl["axisMode"], "story");
        assert_eq!(tl["zoom"], 2.0);
        assert_eq!(tl["scrollOffset"], 120);
        assert_eq!(tl["display"]["showPhasePins"], true);

        cleanup(&dir);
    }

    #[test]
    fn test_global_settings_preserves_frontend_panel_fields() {
        // IPC 型契約テスト: FE (chronicleStore.ts / layoutStore.ts) が
        // read-modify-write で save_global_settings に渡す camelCase フィールドが
        // serde round-trip で silent drop されないことを保証する。
        //
        // 回帰の背景: chronicle フィールドが Rust GlobalSettings に無く
        // deny_unknown_fields も無いため、FE が {..., chronicle} を送っても
        // deserialize 時に黙って捨てられ、年表ビュー設定が毎回消えていた。
        // timeline だけ上に test があり chronicle には無かったことが見落としの
        // 温床だった。ここでは struct を直接構築せず、FE が実際に送る shape の
        // JSON を read（=from_str）→ write（=to_string）→ read で往復させ、
        // struct にフィールドが欠けていれば即座に落ちるようにする。
        let dir = temp_dir("gs_panel_fields");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        let path = dir.join("settings.json");

        let incoming = serde_json::json!({
            "recentWorkspaces": [],
            "lastActiveWorkspace": null,
            "theme": "system",
            "uiLanguage": "ja",
            "uiScale": 100,
            "showLauncherOnStartup": false,
            "chronicle": {
                "zoom": 2.0,
                "pxPerDay": 12.5,
                "viewStartDay": 3.0,
                "locked": true
            },
            "toolWindows": { "codex-quick": { "slot": "right" } },
            "stripePanelIds": ["codex-quick"],
            "stripeSizes": { "right": 320 },
            "stripeVisibility": { "right": true },
            "layoutVersion": 2
        });
        fs::write(&path, serde_json::to_string(&incoming).expect("seed json")).expect("seed write");

        // read = serde_json::from_str (FE→Rust)、write = to_string_pretty (Rust→FE)。
        let loaded = read_global_settings(&path);
        write_global_settings(&path, &loaded).expect("write");
        let reloaded = read_global_settings(&path);

        let ch = reloaded
            .chronicle
            .clone()
            .expect("chronicle field must survive roundtrip");
        assert_eq!(ch["zoom"], 2.0);
        assert_eq!(ch["locked"], true);
        assert_eq!(ch["viewStartDay"], 3.0);

        let tw = reloaded
            .tool_windows
            .clone()
            .expect("toolWindows must survive roundtrip");
        assert_eq!(tw["codex-quick"]["slot"], "right");
        assert!(
            reloaded.stripe_panel_ids.is_some(),
            "stripePanelIds must survive roundtrip"
        );
        assert_eq!(
            reloaded
                .stripe_sizes
                .clone()
                .expect("stripeSizes must survive")["right"],
            320
        );
        assert_eq!(
            reloaded
                .stripe_visibility
                .clone()
                .expect("stripeVisibility must survive")["right"],
            true
        );
        assert_eq!(reloaded.layout_version, Some(2));

        cleanup(&dir);
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
    fn test_global_settings_preserves_accepted_eula_version() {
        let dir = temp_dir("gs_eula");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        let path = dir.join("settings.json");

        let settings = GlobalSettings {
            accepted_eula_version: Some("1.0".to_string()),
            ..GlobalSettings::default()
        };

        write_global_settings(&path, &settings).expect("write");
        let loaded = read_global_settings(&path);

        assert_eq!(loaded.accepted_eula_version, Some("1.0".to_string()));

        cleanup(&dir);
    }

    #[test]
    fn test_global_settings_legacy_json_has_none_eula_version() {
        // Older settings files written before the EULA field existed should
        // deserialize cleanly with `accepted_eula_version = None`.
        let dir = temp_dir("gs_eula_legacy");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        let path = dir.join("settings.json");

        let legacy_json = r#"{
            "recentWorkspaces": [],
            "lastActiveWorkspace": null,
            "theme": "system",
            "uiLanguage": "ja",
            "uiScale": 100,
            "showLauncherOnStartup": false
        }"#;
        fs::write(&path, legacy_json).expect("write");

        let loaded = read_global_settings(&path);
        assert_eq!(loaded.accepted_eula_version, None);
        assert!(!loaded.has_seen_welcome);

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

    // --- user_preferences / project_defaults ---

    #[test]
    fn test_global_settings_user_preferences_roundtrip() {
        let dir = temp_dir("gs_user_prefs");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        let path = dir.join("settings.json");

        let mut prefs = std::collections::HashMap::new();
        prefs.insert("editor.fontFamily".to_string(), "sans-serif".to_string());
        prefs.insert("editor.fontSize".to_string(), "16".to_string());

        let settings = GlobalSettings {
            user_preferences: prefs.clone(),
            ..GlobalSettings::default()
        };

        write_global_settings(&path, &settings).expect("write");
        let loaded = read_global_settings(&path);

        assert_eq!(
            loaded.user_preferences.get("editor.fontFamily"),
            Some(&"sans-serif".to_string())
        );
        assert_eq!(
            loaded.user_preferences.get("editor.fontSize"),
            Some(&"16".to_string())
        );
        cleanup(&dir);
    }

    #[test]
    fn test_global_settings_project_defaults_roundtrip() {
        let dir = temp_dir("gs_proj_defaults");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        let path = dir.join("settings.json");

        let mut defaults = std::collections::HashMap::new();
        defaults.insert("export.format".to_string(), "docx".to_string());
        defaults.insert("editor.targetCharCount".to_string(), "40000".to_string());

        let settings = GlobalSettings {
            project_defaults: defaults,
            ..GlobalSettings::default()
        };

        write_global_settings(&path, &settings).expect("write");
        let loaded = read_global_settings(&path);

        assert_eq!(
            loaded.project_defaults.get("export.format"),
            Some(&"docx".to_string())
        );
        assert_eq!(
            loaded.project_defaults.get("editor.targetCharCount"),
            Some(&"40000".to_string())
        );
        cleanup(&dir);
    }

    #[test]
    fn test_global_settings_legacy_json_has_empty_user_preferences() {
        let dir = temp_dir("gs_legacy_prefs");
        cleanup(&dir);
        fs::create_dir_all(&dir).ok();
        let path = dir.join("settings.json");

        let legacy_json = r#"{
            "recentWorkspaces": [],
            "lastActiveWorkspace": null,
            "theme": "system",
            "uiLanguage": "ja",
            "uiScale": 100,
            "showLauncherOnStartup": false
        }"#;
        fs::write(&path, legacy_json).expect("write");

        let loaded = read_global_settings(&path);
        assert!(loaded.user_preferences.is_empty());
        assert!(loaded.project_defaults.is_empty());
        cleanup(&dir);
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
