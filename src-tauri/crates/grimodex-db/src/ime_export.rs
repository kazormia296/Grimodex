//! Grimodex -> IME dictionary snapshot exporter (protocol format version 1).
//!
//! The exporter intentionally lives in `grimodex-db` so the Electron N-API
//! adapter stays thin and IME consumers only observe atomic JSON snapshots
//! under the app data directory.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use anyhow::{anyhow, bail, Context};
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::Database;

const FORMAT_VERSION: u32 = 1;
const MAX_PROFILE_CHARS: usize = 400;
const MAX_CONSUMER_BYTES: u64 = 64 * 1024;

/// User-selectable IME integration behavior.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImeIntegrationMode {
    /// Export only while at least one valid consumer handshake is present.
    #[default]
    Auto,
    /// Export even when no consumer has registered yet.
    On,
    /// Disable integration and remove existing snapshots.
    Off,
}

/// Per-refresh privacy and payload options supplied by the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImeExportOptions {
    pub mode: ImeIntegrationMode,
    pub exclude_hidden: bool,
    pub include_profile: bool,
}

/// Resolve the process-wide IME preferences from `global-settings.json`.
/// Renderer-provided values remain a fallback for first run / legacy files,
/// while persisted values prevent a stale secondary window from overriding a
/// newer privacy choice made in another window.
pub fn resolve_options_from_preferences(
    preferences: &HashMap<String, String>,
    fallback: &ImeExportOptions,
) -> ImeExportOptions {
    ImeExportOptions {
        mode: resolve_mode_from_preferences(preferences, fallback.mode),
        exclude_hidden: preference_bool(preferences, "ime.excludeHidden", fallback.exclude_hidden),
        include_profile: preference_bool(
            preferences,
            "ime.includeProfile",
            fallback.include_profile,
        ),
    }
}

pub fn resolve_mode_from_preferences(
    preferences: &HashMap<String, String>,
    fallback: ImeIntegrationMode,
) -> ImeIntegrationMode {
    match preferences.get("ime.integrationMode").map(String::as_str) {
        Some("auto") => ImeIntegrationMode::Auto,
        Some("on") => ImeIntegrationMode::On,
        Some("off") => ImeIntegrationMode::Off,
        _ => fallback,
    }
}

fn preference_bool(preferences: &HashMap<String, String>, key: &str, fallback: bool) -> bool {
    match preferences.get(key).map(String::as_str) {
        Some("true") => true,
        Some("false") => false,
        _ => fallback,
    }
}

/// Consumer capability flags advertised in `consumers/<id>.json`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImeConsumerCapabilities {
    pub profile: bool,
}

/// Validated consumer information exposed to the settings UI.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImeConsumerInfo {
    pub consumer_id: String,
    pub name: String,
    pub version: String,
    pub capabilities: ImeConsumerCapabilities,
    pub last_seen: String,
}

/// Current exporter state returned by all mutating commands and status reads.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImeExportStatus {
    pub root_path: PathBuf,
    pub consumers: Vec<ImeConsumerInfo>,
    pub active_project_id: Option<String>,
    pub exported_project_count: usize,
    pub effective_enabled: bool,
}

/// Invocation-order gate for mutating IPC jobs that run on a blocking pool.
///
/// A process mutex prevents simultaneous writes but is not FIFO: an older
/// refresh can acquire it after a newer clear/privacy change and resurrect
/// stale output. Command adapters register requests before spawning work and
/// re-check the returned token after acquiring their writer mutex.
#[derive(Debug, Default)]
pub struct ImeExportRequestGate {
    next_sequence: AtomicU64,
    versions: Mutex<ImeExportRequestVersions>,
}

#[derive(Debug, Default)]
struct ImeExportRequestVersions {
    workspace_generation: u64,
    latest_options: Option<ImeExportOptions>,
    latest_clear: u64,
    pending_clear: Option<u64>,
    latest_refresh_by_project: HashMap<String, u64>,
    latest_remove_by_project: HashMap<String, u64>,
    latest_active: u64,
}

#[derive(Debug, Clone)]
pub struct ImeExportRequestToken {
    sequence: u64,
    kind: ImeExportRequestKind,
}

#[derive(Debug, Clone)]
enum ImeExportRequestKind {
    Refresh {
        project_id: String,
        options: ImeExportOptions,
        workspace_generation: u64,
    },
    Clear,
    Remove {
        project_id: String,
        workspace_generation: u64,
    },
    Active {
        workspace_generation: u64,
    },
}

impl ImeExportRequestGate {
    fn next(&self) -> u64 {
        self.next_sequence.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn lock_versions(&self) -> MutexGuard<'_, ImeExportRequestVersions> {
        match self.versions.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    pub fn register_refresh(
        &self,
        project_id: &str,
        options: &ImeExportOptions,
    ) -> ImeExportRequestToken {
        loop {
            let generation = self.workspace_generation();
            if let Some(token) =
                self.register_refresh_for_generation(project_id, options, generation)
            {
                return token;
            }
        }
    }

    pub fn workspace_generation(&self) -> u64 {
        self.lock_versions().workspace_generation
    }

    pub fn register_refresh_for_generation(
        &self,
        project_id: &str,
        options: &ImeExportOptions,
        workspace_generation: u64,
    ) -> Option<ImeExportRequestToken> {
        let mut versions = self.lock_versions();
        if versions.workspace_generation != workspace_generation {
            return None;
        }
        let sequence = self.next();
        versions.latest_options = Some(options.clone());
        versions
            .latest_refresh_by_project
            .insert(project_id.to_owned(), sequence);
        Some(ImeExportRequestToken {
            sequence,
            kind: ImeExportRequestKind::Refresh {
                project_id: project_id.to_owned(),
                options: options.clone(),
                workspace_generation,
            },
        })
    }

    pub fn register_clear(&self) -> ImeExportRequestToken {
        let sequence = self.next();
        let mut versions = self.lock_versions();
        versions.latest_clear = sequence;
        versions.pending_clear = Some(sequence);
        ImeExportRequestToken {
            sequence,
            kind: ImeExportRequestKind::Clear,
        }
    }

    pub fn register_remove(&self, project_id: &str) -> ImeExportRequestToken {
        loop {
            let generation = self.workspace_generation();
            if let Some(token) = self.register_remove_for_generation(project_id, generation) {
                return token;
            }
        }
    }

    pub fn register_remove_for_generation(
        &self,
        project_id: &str,
        workspace_generation: u64,
    ) -> Option<ImeExportRequestToken> {
        let mut versions = self.lock_versions();
        if versions.workspace_generation != workspace_generation {
            return None;
        }
        let sequence = self.next();
        versions
            .latest_remove_by_project
            .insert(project_id.to_owned(), sequence);
        Some(ImeExportRequestToken {
            sequence,
            kind: ImeExportRequestKind::Remove {
                project_id: project_id.to_owned(),
                workspace_generation,
            },
        })
    }

    pub fn register_active(&self) -> ImeExportRequestToken {
        loop {
            let generation = self.workspace_generation();
            if let Some(token) = self.register_active_for_generation(generation) {
                return token;
            }
        }
    }

    pub fn register_active_for_generation(
        &self,
        workspace_generation: u64,
    ) -> Option<ImeExportRequestToken> {
        let mut versions = self.lock_versions();
        if versions.workspace_generation != workspace_generation {
            return None;
        }
        let sequence = self.next();
        versions.latest_active = sequence;
        Some(ImeExportRequestToken {
            sequence,
            kind: ImeExportRequestKind::Active {
                workspace_generation,
            },
        })
    }

    /// Invalidate every request bound to the previous active database. This is
    /// called from the shell's swap hook while holding its IME writer mutex.
    pub fn rotate_workspace(&self) {
        let mut versions = self.lock_versions();
        versions.workspace_generation = versions.workspace_generation.wrapping_add(1);
        versions.latest_refresh_by_project.clear();
        versions.latest_remove_by_project.clear();
        versions.latest_active = 0;
    }

    pub fn is_current(&self, token: &ImeExportRequestToken) -> bool {
        let versions = self.lock_versions();
        match &token.kind {
            ImeExportRequestKind::Refresh {
                project_id,
                options,
                workspace_generation,
            } => {
                versions.workspace_generation == *workspace_generation
                    && versions.pending_clear.is_none()
                    && versions.latest_options.as_ref() == Some(options)
                    && versions.latest_clear < token.sequence
                    && versions
                        .latest_remove_by_project
                        .get(project_id)
                        .is_none_or(|sequence| *sequence < token.sequence)
                    && versions.latest_refresh_by_project.get(project_id) == Some(&token.sequence)
            }
            ImeExportRequestKind::Clear => {
                versions.latest_clear == token.sequence
                    && versions.pending_clear == Some(token.sequence)
            }
            ImeExportRequestKind::Remove {
                project_id,
                workspace_generation,
            } => {
                versions.workspace_generation == *workspace_generation
                    && versions.latest_remove_by_project.get(project_id) == Some(&token.sequence)
                    && versions
                        .latest_refresh_by_project
                        .get(project_id)
                        .is_none_or(|sequence| *sequence < token.sequence)
            }
            ImeExportRequestKind::Active {
                workspace_generation,
            } => {
                versions.workspace_generation == *workspace_generation
                    && versions.latest_active == token.sequence
            }
        }
    }

    /// Whether a workspace-scoped token still belongs to the active native DB
    /// generation. This deliberately ignores same-generation latest-wins
    /// supersession so adapters can distinguish "retry after swap" from a
    /// harmless newer request for the same resource.
    pub fn is_workspace_generation_current(&self, token: &ImeExportRequestToken) -> bool {
        let versions = self.lock_versions();
        let token_generation = match &token.kind {
            ImeExportRequestKind::Refresh {
                workspace_generation,
                ..
            }
            | ImeExportRequestKind::Remove {
                workspace_generation,
                ..
            }
            | ImeExportRequestKind::Active {
                workspace_generation,
            } => Some(*workspace_generation),
            ImeExportRequestKind::Clear => None,
        };
        token_generation.is_none_or(|generation| generation == versions.workspace_generation)
    }

    /// Release the global clear barrier after the matching clear job has
    /// finished. Refreshes registered while the clear was waiting either skip
    /// before it or run after it; none can make the clear itself a no-op.
    pub fn finish_clear(&self, token: &ImeExportRequestToken) {
        if !matches!(&token.kind, ImeExportRequestKind::Clear) {
            return;
        }
        let mut versions = self.lock_versions();
        if versions.pending_clear == Some(token.sequence) {
            versions.pending_clear = None;
        }
    }
}

#[derive(Debug)]
struct ProjectData {
    id: String,
    title: String,
    language: String,
    genre: Option<String>,
    outline: Option<String>,
    entries: Vec<CodexData>,
}

#[derive(Debug)]
struct CodexData {
    id: String,
    entry_type: String,
    name: String,
    aliases: Option<String>,
    excluded_aliases: Option<String>,
    readings: Option<String>,
    context_mode: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct ProjectSnapshot {
    format_version: u32,
    project_id: String,
    project_name: String,
    generated_at: String,
    entries: Vec<ExportEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ExportEntry {
    yomi: String,
    surface: String,
    category: String,
    priority: u8,
    entry_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct ExportState {
    format_version: u32,
    active_project_id: Option<String>,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct ConsumerHandshake {
    format_version: u32,
    consumer_id: String,
    name: String,
    version: String,
    capabilities: ImeConsumerCapabilities,
    last_seen: String,
}

/// Rebuild one Japanese project's dictionary snapshot and return current status.
///
/// `auto` without a valid consumer and `off` both remove prior exported data;
/// a Japanese -> non-Japanese language change removes just that project and
/// deactivates it when necessary.
pub fn refresh_project_export(
    db: &Database,
    root: &Path,
    project_id: &str,
    options: &ImeExportOptions,
) -> anyhow::Result<ImeExportStatus> {
    validate_project_id(project_id)?;

    if options.mode == ImeIntegrationMode::Off {
        clear_all_exports(root)?;
        return get_status(root, options.mode);
    }
    if options.mode == ImeIntegrationMode::Auto && detect_consumers(root)?.is_empty() {
        clear_all_exports(root)?;
        return get_status(root, options.mode);
    }

    let Some(project) = load_project(db, project_id)? else {
        // A refresh already queued in another renderer may outlive Project
        // deletion and become newer than the explicit remove request. Treat
        // that specific absence as convergent cleanup; real SQL errors still
        // propagate unchanged.
        remove_project_export(root, project_id)?;
        return get_status(root, options.mode);
    };
    if !is_japanese_language(&project.language) {
        remove_project_export(root, project_id)?;
        return get_status(root, options.mode);
    }

    let snapshot = build_snapshot(project, options);
    let path = project_snapshot_path(root, project_id);
    atomic_write_json(&path, &snapshot)?;
    get_status(root, options.mode)
}

/// Point consumers at a snapshot only when integration is enabled and that
/// snapshot exists. Invalid/missing project IDs always deactivate instead of
/// leaving `state.json` pointing at a missing file.
pub fn set_active_project(
    root: &Path,
    project_id: Option<&str>,
    mode: ImeIntegrationMode,
) -> anyhow::Result<ImeExportStatus> {
    if let Some(id) = project_id {
        validate_project_id(id)?;
    }

    if mode == ImeIntegrationMode::Off
        || (mode == ImeIntegrationMode::Auto && detect_consumers(root)?.is_empty())
    {
        clear_all_exports(root)?;
        return get_status(root, mode);
    }

    let desired = project_id
        .filter(|id| project_snapshot_path(root, id).is_file())
        .map(str::to_owned);

    // Do not create the IME directory merely to persist an inactive state.
    if !root.exists() && desired.is_none() {
        return get_status(root, mode);
    }

    let current = read_state(root)?.and_then(|state| state.active_project_id);
    if current != desired {
        write_state(root, desired)?;
    }
    get_status(root, mode)
}

/// Inspect handshakes and snapshots without creating or modifying any files.
pub fn get_status(root: &Path, mode: ImeIntegrationMode) -> anyhow::Result<ImeExportStatus> {
    let consumers = detect_consumers(root)?;
    let effective_enabled = match mode {
        ImeIntegrationMode::Auto => !consumers.is_empty(),
        ImeIntegrationMode::On => true,
        ImeIntegrationMode::Off => false,
    };
    let exported_project_count = count_project_snapshots(root)?;
    let active_project_id = read_state(root)?
        .and_then(|state| state.active_project_id)
        .filter(|id| project_snapshot_path(root, id).is_file());

    Ok(ImeExportStatus {
        root_path: root.to_path_buf(),
        consumers,
        active_project_id,
        exported_project_count,
        effective_enabled,
    })
}

/// Remove all project snapshots and clear active state, preserving consumer
/// handshake files so auto-detection continues to work.
pub fn clear_all_exports(root: &Path) -> anyhow::Result<()> {
    if !root.exists() {
        return Ok(());
    }

    // Remove the pointer before removing dictionaries. A failure can therefore
    // leave an unreferenced old snapshot, never a pointer to a missing file.
    // Deleting (rather than rewriting a null state) also preserves the contract
    // that off/auto-without-consumer leaves no Grimodex-generated export files.
    remove_state_file(root)?;
    let projects = root.join("projects");
    match fs::remove_dir_all(&projects) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("remove IME project snapshots"),
    }
    Ok(())
}

/// Remove one project's snapshot, clearing active state first when it points to
/// that project. The ID is validated before any filesystem mutation.
pub fn remove_project_export(root: &Path, project_id: &str) -> anyhow::Result<()> {
    validate_project_id(project_id)?;
    if !root.exists() {
        return Ok(());
    }

    let active = read_state(root)?.and_then(|state| state.active_project_id);
    if active.as_deref() == Some(project_id) {
        remove_state_file(root)?;
    }

    match fs::remove_file(project_snapshot_path(root, project_id)) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("remove IME project snapshot"),
    }
    Ok(())
}

/// Remove a delayed deletion snapshot only while the pinned database still
/// confirms that the Project is absent. A same-path restore/recreate can reuse
/// the same id; in that case the old cleanup request must not delete the new
/// Project's snapshot.
pub fn remove_project_export_if_absent(
    db: &Database,
    root: &Path,
    project_id: &str,
) -> anyhow::Result<bool> {
    validate_project_id(project_id)?;
    let exists = db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT 1 FROM projects WHERE id = ?1",
                params![project_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    })?;
    if exists {
        return Ok(false);
    }
    remove_project_export(root, project_id)?;
    Ok(true)
}

fn validate_project_id(project_id: &str) -> anyhow::Result<()> {
    if project_id.is_empty()
        || !project_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        bail!("invalid IME project id: {project_id:?}");
    }
    Ok(())
}

fn project_snapshot_path(root: &Path, project_id: &str) -> PathBuf {
    root.join("projects").join(format!("{project_id}.json"))
}

fn load_project(db: &Database, project_id: &str) -> anyhow::Result<Option<ProjectData>> {
    db.with_conn(|conn| {
        let Some(project) = conn
            .query_row(
                "SELECT id, title, language, genre, outline FROM projects WHERE id = ?1",
                params![project_id],
                |row| {
                    Ok(ProjectData {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        language: row.get(2)?,
                        genre: row.get(3)?,
                        outline: row.get(4)?,
                        entries: Vec::new(),
                    })
                },
            )
            .optional()?
        else {
            return Ok(None);
        };

        let mut statement = conn.prepare(
            "SELECT id, type, name, aliases, excluded_aliases, readings, context_mode
             FROM codex_entries
             WHERE project_id = ?1
             ORDER BY CASE context_mode WHEN 'always' THEN 0 ELSE 1 END, created_at, id",
        )?;
        let rows = statement.query_map(params![project_id], |row| {
            Ok(CodexData {
                id: row.get(0)?,
                entry_type: row.get(1)?,
                name: row.get(2)?,
                aliases: row.get(3)?,
                excluded_aliases: row.get(4)?,
                readings: row.get(5)?,
                context_mode: row.get(6)?,
            })
        })?;

        let mut project = project;
        for row in rows {
            project.entries.push(row?);
        }
        Ok(Some(project))
    })
}

fn build_snapshot(project: ProjectData, options: &ImeExportOptions) -> ProjectSnapshot {
    let included: Vec<&CodexData> = project
        .entries
        .iter()
        .filter(|entry| {
            !options.exclude_hidden
                || (entry.context_mode != "hidden" && entry.context_mode != "suppress")
        })
        .collect();

    let mut entries = Vec::new();
    for entry in &included {
        append_export_entries(entry, &mut entries);
    }

    let profile = options
        .include_profile
        .then(|| {
            build_profile(
                project.genre.as_deref(),
                project.outline.as_deref(),
                &included,
            )
        })
        .flatten();

    ProjectSnapshot {
        format_version: FORMAT_VERSION,
        project_id: project.id,
        project_name: project.title,
        generated_at: timestamp(),
        entries,
        profile,
    }
}

fn append_export_entries(entry: &CodexData, out: &mut Vec<ExportEntry>) {
    let aliases = parse_string_array(entry.aliases.as_deref());
    let excluded: HashSet<String> = parse_string_array(entry.excluded_aliases.as_deref())
        .into_iter()
        .map(|alias| alias.trim().to_owned())
        .filter(|alias| !alias.is_empty())
        .collect();
    let readings = parse_reading_map(entry.readings.as_deref());

    let mut surfaces = Vec::new();
    let mut seen_surfaces = HashSet::new();
    let name = entry.name.trim();
    if !name.is_empty() {
        seen_surfaces.insert(name.to_owned());
        surfaces.push(name.to_owned());
    }
    for raw in aliases {
        let alias = raw.trim();
        if alias.is_empty() || excluded.contains(alias) || !seen_surfaces.insert(alias.to_owned()) {
            continue;
        }
        surfaces.push(alias.to_owned());
    }

    let category = category_for_type(&entry.entry_type);
    let priority = if entry.context_mode == "always" { 2 } else { 1 };
    for surface in surfaces {
        let yomis = match readings.get(&surface) {
            Some(explicit) => explicit
                .iter()
                .map(|reading| normalize_reading(reading))
                .filter(|reading| !reading.is_empty())
                .collect::<Vec<_>>(),
            None => derive_reading(&surface).into_iter().collect(),
        };

        let mut seen_yomis = HashSet::new();
        for yomi in yomis {
            if !seen_yomis.insert(yomi.clone()) {
                continue;
            }
            out.push(ExportEntry {
                yomi,
                surface: surface.clone(),
                category: category.to_owned(),
                priority,
                entry_id: entry.id.clone(),
            });
        }
    }
}

fn parse_string_array(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    match serde_json::from_str(raw) {
        Ok(values) => values,
        Err(error) => {
            tracing::warn!("ignoring invalid Codex string-array JSON during IME export: {error}");
            Vec::new()
        }
    }
}

fn parse_reading_map(raw: Option<&str>) -> HashMap<String, Vec<String>> {
    let Some(raw) = raw else {
        return HashMap::new();
    };
    match serde_json::from_str(raw) {
        Ok(map) => map,
        Err(error) => {
            tracing::warn!("ignoring invalid Codex readings JSON during IME export: {error}");
            HashMap::new()
        }
    }
}

fn category_for_type(entry_type: &str) -> &'static str {
    match entry_type {
        "character" => "person",
        "location" => "place",
        _ => "noun",
    }
}

/// Mirrors `src/features/codex/reading.ts::normalizeReading`.
fn normalize_reading(value: &str) -> String {
    value
        .trim()
        .nfkc()
        .map(|ch| {
            let code = ch as u32;
            if (0x30a1..=0x30f6).contains(&code) {
                match char::from_u32(code - 0x60) {
                    Some(hiragana) => hiragana,
                    None => ch,
                }
            } else {
                ch
            }
        })
        .collect()
}

/// Mirrors `src/features/codex/reading.ts::deriveReading`.
fn derive_reading(surface: &str) -> Option<String> {
    let trimmed = surface.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized: String = trimmed.nfkc().collect();
    if normalized
        .chars()
        .all(|ch| (0x20..=0x7e).contains(&(ch as u32)))
    {
        return Some(normalize_reading(surface));
    }

    let kana_only = normalized.chars().all(|ch| {
        let code = ch as u32;
        (0x3040..=0x309f).contains(&code) || (0x30a0..=0x30ff).contains(&code)
    });
    if !kana_only {
        return None;
    }
    let derived = normalize_reading(surface);
    if is_hiragana_reading(&derived) {
        Some(derived)
    } else {
        None
    }
}

fn is_hiragana_reading(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|ch| {
            let code = ch as u32;
            (0x3041..=0x3096).contains(&code)
                || (0x309d..=0x309e).contains(&code)
                || code == 0x30fc
                || code == 0x30fb
        })
}

fn build_profile(
    genre: Option<&str>,
    outline: Option<&str>,
    entries: &[&CodexData],
) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(genre) = genre.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(japanese_genre_label(genre));
    }
    if let Some(outline) = outline.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(outline.to_owned());
    }

    let mut names = Vec::new();
    let mut seen = HashSet::new();
    for entry in entries {
        let name = entry.name.trim();
        if !name.is_empty() && seen.insert(name.to_owned()) {
            names.push(name.to_owned());
        }
    }
    if !names.is_empty() {
        parts.push(format!("主要項目: {}", names.join("、")));
    }

    if parts.is_empty() {
        return None;
    }
    Some(parts.join("。").chars().take(MAX_PROFILE_CHARS).collect())
}

fn japanese_genre_label(genre: &str) -> String {
    match genre {
        "Fantasy" => "ファンタジー".to_owned(),
        "Sci-Fi" => "SF".to_owned(),
        "Mystery" => "ミステリー".to_owned(),
        "Horror" => "ホラー".to_owned(),
        "Romance" => "恋愛".to_owned(),
        "Thriller" => "スリラー".to_owned(),
        "Literary" => "文芸".to_owned(),
        "Historical" => "歴史".to_owned(),
        "Other" => "その他".to_owned(),
        value => value.to_owned(),
    }
}

fn is_japanese_language(language: &str) -> bool {
    let language = language.trim().to_ascii_lowercase();
    language == "ja" || language.starts_with("ja-") || language.starts_with("ja_")
}

fn detect_consumers(root: &Path) -> anyhow::Result<Vec<ImeConsumerInfo>> {
    let dir = root.join("consumers");
    let read_dir = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("read IME consumer directory"),
    };

    let mut paths = Vec::new();
    for entry in read_dir {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tracing::warn!("ignoring vanished IME consumer directory entry: {error}");
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                tracing::warn!(path = %entry.path().display(), "ignoring inaccessible IME consumer entry: {error}");
                continue;
            }
        };
        if file_type.is_file()
            && entry.path().extension().and_then(|value| value.to_str()) == Some("json")
        {
            paths.push(entry.path());
        }
    }
    paths.sort();

    let mut consumers = Vec::new();
    let mut seen_ids = HashSet::new();
    for path in paths {
        // Read at most limit+1 bytes from the opened handle. A metadata check
        // followed by fs::read would be a TOCTOU window where an untrusted
        // consumer could replace a small handshake with an arbitrarily large
        // file between the two operations.
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) => {
                tracing::warn!(path = %path.display(), "ignoring unreadable IME consumer handshake: {error}");
                continue;
            }
        };
        let mut bytes = Vec::new();
        if let Err(error) = file.take(MAX_CONSUMER_BYTES + 1).read_to_end(&mut bytes) {
            tracing::warn!(path = %path.display(), "ignoring unreadable IME consumer handshake: {error}");
            continue;
        }
        if bytes.len() as u64 > MAX_CONSUMER_BYTES {
            tracing::warn!(path = %path.display(), "ignoring oversized IME consumer handshake");
            continue;
        }
        let handshake: ConsumerHandshake = match serde_json::from_slice(&bytes) {
            Ok(handshake) => handshake,
            Err(error) => {
                tracing::warn!(path = %path.display(), "ignoring invalid IME consumer handshake: {error}");
                continue;
            }
        };
        let file_id = path.file_stem().and_then(|value| value.to_str());
        if handshake.format_version != FORMAT_VERSION
            || file_id != Some(handshake.consumer_id.as_str())
            || !valid_consumer_id(&handshake.consumer_id)
            || handshake.name.trim().is_empty()
            || handshake.version.trim().is_empty()
            || handshake.last_seen.trim().is_empty()
            || !seen_ids.insert(handshake.consumer_id.clone())
        {
            tracing::warn!(path = %path.display(), "ignoring incompatible IME consumer handshake");
            continue;
        }
        consumers.push(ImeConsumerInfo {
            consumer_id: handshake.consumer_id,
            name: handshake.name,
            version: handshake.version,
            capabilities: handshake.capabilities,
            last_seen: handshake.last_seen,
        });
    }
    consumers.sort_by(|left, right| left.consumer_id.cmp(&right.consumer_id));
    Ok(consumers)
}

fn valid_consumer_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn count_project_snapshots(root: &Path) -> anyhow::Result<usize> {
    let dir = root.join("projects");
    let read_dir = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error).context("read IME project snapshot directory"),
    };

    let mut count = 0;
    for entry in read_dir {
        let entry = entry.context("read IME project snapshot entry")?;
        if !entry
            .file_type()
            .context("inspect IME project snapshot entry")?
            .is_file()
        {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if validate_project_id(stem).is_err() {
            continue;
        }
        let snapshot: ProjectSnapshot = match fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(snapshot) => snapshot,
            None => continue,
        };
        if snapshot.format_version == FORMAT_VERSION && snapshot.project_id == stem {
            count += 1;
        }
    }
    Ok(count)
}

fn read_state(root: &Path) -> anyhow::Result<Option<ExportState>> {
    let path = root.join("state.json");
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("read IME state"),
    };
    let state: ExportState = serde_json::from_slice(&bytes).context("parse IME state")?;
    if state.format_version != FORMAT_VERSION {
        bail!(
            "unsupported IME state format version: {}",
            state.format_version
        );
    }
    if let Some(project_id) = state.active_project_id.as_deref() {
        validate_project_id(project_id)?;
    }
    Ok(Some(state))
}

fn write_state(root: &Path, active_project_id: Option<String>) -> anyhow::Result<()> {
    atomic_write_json(
        &root.join("state.json"),
        &ExportState {
            format_version: FORMAT_VERSION,
            active_project_id,
            updated_at: timestamp(),
        },
    )
}

fn remove_state_file(root: &Path) -> anyhow::Result<()> {
    match fs::remove_file(root.join("state.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("remove IME state"),
    }
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("IME export path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).context("create IME export directory")?;

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("IME export filename is not valid UTF-8: {}", path.display()))?;
    let temp = parent.join(format!("{file_name}.tmp.{}", uuid::Uuid::new_v4()));
    let mut payload = serde_json::to_vec_pretty(value).context("serialize IME export JSON")?;
    payload.push(b'\n');

    let result = (|| -> anyhow::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .context("create IME export staging file")?;
        file.write_all(&payload)
            .context("write IME export staging file")?;
        file.sync_all().context("sync IME export staging file")?;
        drop(file);
        atomic_replace(&temp, path).context("atomically replace IME export JSON")?;
        sync_parent_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(not(windows))]
fn atomic_replace(staged: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(staged, destination)
}

#[cfg(windows)]
fn atomic_replace(staged: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let staged_parent = staged.parent().ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidInput,
            "IME export staging path has no parent",
        )
    })?;
    let destination_parent = destination.parent().ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidInput,
            "IME export destination path has no parent",
        )
    })?;
    // `canonicalize` returns extended-length (`\\?\`) paths on Windows. Resolve
    // both parents independently so long redirected APPDATA/userData paths work,
    // then require one directory to keep the replacement a same-volume rename.
    let staged_parent = fs::canonicalize(staged_parent)?;
    let destination_parent = fs::canonicalize(destination_parent)?;
    if staged_parent != destination_parent {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "IME export staging and destination files must share one directory",
        ));
    }

    let staged = staged_parent.join(staged.file_name().ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidInput,
            "IME export staging path has no filename",
        )
    })?);
    let destination = destination_parent.join(destination.file_name().ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidInput,
            "IME export destination path has no filename",
        )
    })?);
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let staged_wide: Vec<u16> = staged
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: both UTF-16 buffers are NUL-terminated and live through the call.
    // Their canonical parents are identical, so COPY_ALLOWED is intentionally
    // omitted and Windows performs one same-volume replacement.
    let moved = unsafe {
        MoveFileExW(
            staged_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> anyhow::Result<()> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .context("sync IME export directory")
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(all(test, windows))]
mod atomic_replace_tests {
    use super::*;
    use std::os::windows::ffi::OsStrExt;

    fn exercise_atomic_write_twice(destination: &Path) -> anyhow::Result<()> {
        fs::write(destination, br#"{"generation":0}"#)?;
        atomic_write_json(
            destination,
            &serde_json::json!({"generation": 1, "entries": ["first"]}),
        )?;
        atomic_write_json(
            destination,
            &serde_json::json!({"generation": 2, "entries": ["final"]}),
        )?;

        let value: serde_json::Value = serde_json::from_slice(&fs::read(destination)?)?;
        assert_eq!(
            value,
            serde_json::json!({"generation": 2, "entries": ["final"]})
        );
        let parent = destination
            .parent()
            .ok_or_else(|| anyhow!("test destination has no parent: {}", destination.display()))?;
        for entry in fs::read_dir(parent)? {
            let name = entry?.file_name();
            assert!(
                !name.to_string_lossy().contains(".tmp."),
                "atomic staging file must be consumed: {}",
                name.to_string_lossy()
            );
        }
        Ok(())
    }

    #[test]
    fn windows_atomic_write_replaces_existing_destination_twice() -> anyhow::Result<()> {
        let sandbox = std::env::temp_dir().join(format!(
            "grimodex-ime-atomic-replace-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&sandbox)?;
        let destination = sandbox.join("snapshot.json");
        let result = exercise_atomic_write_twice(&destination);
        let _ = fs::remove_dir_all(&sandbox);
        result
    }

    #[test]
    fn windows_atomic_write_supports_parent_longer_than_max_path() -> anyhow::Result<()> {
        let sandbox = std::env::temp_dir().join(format!(
            "grimodex-ime-atomic-long-path-test-{}",
            uuid::Uuid::new_v4()
        ));
        let mut long_parent = sandbox.clone();
        let mut segment = 0_u32;
        while long_parent.as_os_str().encode_wide().count() <= 260 {
            long_parent.push(format!("segment-{segment:02}-{}", "x".repeat(24)));
            segment += 1;
        }
        fs::create_dir_all(&long_parent)?;
        assert!(long_parent.as_os_str().encode_wide().count() > 260);

        let destination = long_parent.join("snapshot.json");
        let result = exercise_atomic_write_twice(&destination);
        let _ = fs::remove_dir_all(&sandbox);

        result?;
        Ok(())
    }
}

#[cfg(test)]
mod request_gate_tests {
    use super::*;

    fn options(mode: ImeIntegrationMode, include_profile: bool) -> ImeExportOptions {
        ImeExportOptions {
            mode,
            exclude_hidden: false,
            include_profile,
        }
    }

    #[test]
    fn clear_blocks_refreshes_until_the_clear_finishes() {
        let gate = ImeExportRequestGate::default();
        let opts = options(ImeIntegrationMode::On, true);
        let old_refresh = gate.register_refresh("p1", &opts);
        let clear = gate.register_clear();
        assert!(!gate.is_current(&old_refresh));
        assert!(gate.is_current(&clear));

        let new_refresh = gate.register_refresh("p1", &opts);
        assert!(gate.is_current(&clear));
        assert!(!gate.is_current(&new_refresh));
        gate.finish_clear(&clear);
        assert!(!gate.is_current(&clear));
        assert!(gate.is_current(&new_refresh));
    }

    #[test]
    fn a_newer_clear_keeps_the_barrier_until_that_clear_finishes() {
        let gate = ImeExportRequestGate::default();
        let opts = options(ImeIntegrationMode::On, true);
        let old_clear = gate.register_clear();
        let new_clear = gate.register_clear();
        let refresh = gate.register_refresh("p1", &opts);

        assert!(!gate.is_current(&old_clear));
        gate.finish_clear(&old_clear);
        assert!(!gate.is_current(&refresh));
        assert!(gate.is_current(&new_clear));

        gate.finish_clear(&new_clear);
        assert!(gate.is_current(&refresh));
    }

    #[test]
    fn global_privacy_change_invalidates_old_options_but_not_other_projects() {
        let gate = ImeExportRequestGate::default();
        let original = options(ImeIntegrationMode::On, true);
        let p1 = gate.register_refresh("p1", &original);
        let p2 = gate.register_refresh("p2", &original);
        assert!(gate.is_current(&p1));
        assert!(gate.is_current(&p2));

        let private = options(ImeIntegrationMode::On, false);
        let p2_private = gate.register_refresh("p2", &private);
        assert!(!gate.is_current(&p1));
        assert!(!gate.is_current(&p2));
        assert!(gate.is_current(&p2_private));
    }

    #[test]
    fn remove_and_active_requests_are_latest_wins_for_their_resource() {
        let gate = ImeExportRequestGate::default();
        let opts = options(ImeIntegrationMode::On, true);
        let refresh = gate.register_refresh("p1", &opts);
        let remove = gate.register_remove("p1");
        assert!(!gate.is_current(&refresh));
        assert!(gate.is_current(&remove));

        let recreated = gate.register_refresh("p1", &opts);
        assert!(!gate.is_current(&remove));
        assert!(gate.is_current(&recreated));

        let old_active = gate.register_active();
        let new_active = gate.register_active();
        assert!(!gate.is_current(&old_active));
        assert!(gate.is_current(&new_active));
    }

    #[test]
    fn workspace_rotation_invalidates_old_requests_even_when_project_ids_match() {
        let gate = ImeExportRequestGate::default();
        let opts = options(ImeIntegrationMode::On, true);
        let old_refresh = gate.register_refresh("default-project", &opts);
        let old_remove = gate.register_remove("default-project");
        let old_active = gate.register_active();

        gate.rotate_workspace();

        let new_refresh = gate.register_refresh("default-project", &opts);
        let new_active = gate.register_active();
        assert!(!gate.is_current(&old_refresh));
        assert!(!gate.is_current(&old_remove));
        assert!(!gate.is_current(&old_active));
        assert!(gate.is_current(&new_refresh));
        assert!(gate.is_current(&new_active));
    }

    #[test]
    fn conditional_registration_never_mutates_a_new_workspace_generation() {
        let gate = ImeExportRequestGate::default();
        let opts = options(ImeIntegrationMode::On, true);
        let old_generation = gate.workspace_generation();
        gate.rotate_workspace();

        assert!(gate
            .register_refresh_for_generation("default-project", &opts, old_generation)
            .is_none());
        assert!(gate
            .register_remove_for_generation("default-project", old_generation)
            .is_none());
        assert!(gate
            .register_active_for_generation(old_generation)
            .is_none());

        let current = gate.register_refresh("default-project", &opts);
        assert!(gate.is_current(&current));
    }

    #[test]
    fn generation_check_distinguishes_swap_from_same_workspace_supersession() {
        let gate = ImeExportRequestGate::default();
        let opts = options(ImeIntegrationMode::On, true);
        let remove = gate.register_remove("default-project");
        let refresh = gate.register_refresh("default-project", &opts);
        assert!(!gate.is_current(&remove));
        assert!(gate.is_workspace_generation_current(&remove));

        gate.rotate_workspace();
        assert!(!gate.is_workspace_generation_current(&remove));
        assert!(!gate.is_workspace_generation_current(&refresh));
    }

    #[test]
    fn persisted_preferences_override_stale_renderer_values() {
        let fallback = options(ImeIntegrationMode::On, true);
        let preferences = HashMap::from([
            ("ime.integrationMode".to_owned(), "off".to_owned()),
            ("ime.excludeHidden".to_owned(), "true".to_owned()),
            ("ime.includeProfile".to_owned(), "false".to_owned()),
        ]);
        let resolved = resolve_options_from_preferences(&preferences, &fallback);
        assert_eq!(resolved.mode, ImeIntegrationMode::Off);
        assert!(resolved.exclude_hidden);
        assert!(!resolved.include_profile);
    }
}
