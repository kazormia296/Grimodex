use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use grimodex_db::ime_export::{
    clear_all_exports, get_status, refresh_project_export, remove_project_export,
    set_active_project, ImeExportOptions, ImeIntegrationMode,
};
use grimodex_db::Database;
use rusqlite::params;
use serde::Deserialize;
use serde_json::Value;

type TestResult = Result<(), Box<dyn Error>>;

struct Fixture {
    db: Option<Database>,
    sandbox: PathBuf,
    ime_root: PathBuf,
}

impl Fixture {
    fn new() -> Result<Self, Box<dyn Error>> {
        let sandbox =
            std::env::temp_dir().join(format!("grimodex-ime-export-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&sandbox)?;
        let db = Database::new(&sandbox.join("grimodex.db"))?;
        db.migrate()?;
        let ime_root = sandbox.join("app-data").join("ime");
        Ok(Self {
            db: Some(db),
            sandbox,
            ime_root,
        })
    }

    fn db(&self) -> &Database {
        self.db
            .as_ref()
            .expect("fixture database must remain alive during the test")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Windows cannot remove an open SQLite file. Drop the connection first.
        let _ = self.db.take();
        let _ = fs::remove_dir_all(&self.sandbox);
    }
}

#[derive(Debug, Deserialize)]
struct ProjectSnapshot {
    format_version: u32,
    project_id: String,
    project_name: String,
    entries: Vec<ExportEntry>,
    #[serde(default)]
    profile: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct ExportEntry {
    yomi: String,
    surface: String,
    category: String,
    priority: u8,
    entry_id: String,
}

#[derive(Debug, Deserialize)]
struct ExportState {
    format_version: u32,
    active_project_id: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn seed_project(
    db: &Database,
    id: &str,
    title: &str,
    language: &str,
    genre: Option<&str>,
    outline: Option<&str>,
) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title, language, genre, outline)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, title, language, genre, outline],
        )?;
        for (slug, label) in [
            ("character", "Character"),
            ("location", "Location"),
            ("lore", "Lore"),
        ] {
            conn.execute(
                "INSERT INTO codex_types (id, project_id, slug, label)
                 VALUES (?1, ?2, ?3, ?4)",
                params![format!("{id}-type-{slug}"), id, slug, label],
            )?;
        }
        Ok(())
    })
}

#[allow(clippy::too_many_arguments)]
fn seed_entry(
    db: &Database,
    id: &str,
    project_id: &str,
    entry_type: &str,
    name: &str,
    aliases: Option<&str>,
    excluded_aliases: Option<&str>,
    readings: Option<&str>,
    context_mode: &str,
) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_entries
                (id, project_id, type, name, aliases, excluded_aliases, readings, context_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                project_id,
                entry_type,
                name,
                aliases,
                excluded_aliases,
                readings,
                context_mode
            ],
        )?;
        Ok(())
    })
}

fn options(mode: ImeIntegrationMode) -> ImeExportOptions {
    ImeExportOptions {
        mode,
        exclude_hidden: false,
        include_profile: true,
    }
}

fn project_snapshot_path(root: &Path, project_id: &str) -> PathBuf {
    root.join("projects").join(format!("{project_id}.json"))
}

fn read_snapshot(root: &Path, project_id: &str) -> Result<ProjectSnapshot, Box<dyn Error>> {
    let bytes = fs::read(project_snapshot_path(root, project_id))?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn read_snapshot_value(root: &Path, project_id: &str) -> Result<Value, Box<dyn Error>> {
    let bytes = fs::read(project_snapshot_path(root, project_id))?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn read_active_project(root: &Path) -> Result<Option<String>, Box<dyn Error>> {
    let path = root.join("state.json");
    if !path.exists() {
        return Ok(None);
    }
    let state: ExportState = serde_json::from_slice(&fs::read(path)?)?;
    if state.format_version != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected state format version: {}", state.format_version),
        )
        .into());
    }
    Ok(state.active_project_id)
}

fn find_entry<'a>(
    snapshot: &'a ProjectSnapshot,
    entry_id: &str,
    surface: &str,
    yomi: &str,
) -> Option<&'a ExportEntry> {
    snapshot
        .entries
        .iter()
        .find(|entry| entry.entry_id == entry_id && entry.surface == surface && entry.yomi == yomi)
}

fn json_field<'a>(value: &'a Value, names: &[&str]) -> Result<&'a Value, Box<dyn Error>> {
    names
        .iter()
        .find_map(|name| value.get(*name))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("status is missing one of fields {names:?}: {value}"),
            )
            .into()
        })
}

fn status_enabled(value: &Value) -> Result<bool, Box<dyn Error>> {
    json_field(value, &["effective_enabled", "effectiveEnabled", "enabled"])?
        .as_bool()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "enabled must be bool").into())
}

fn status_consumer_count(value: &Value) -> Result<u64, Box<dyn Error>> {
    let consumers = json_field(value, &["consumers"])?
        .as_array()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "consumers must be an array"))?;
    Ok(consumers.len() as u64)
}

fn status_output_dir(value: &Value) -> Result<PathBuf, Box<dyn Error>> {
    let path = json_field(value, &["root_path", "rootPath"])?
        .as_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "output dir must be a string"))?;
    Ok(PathBuf::from(path))
}

fn assert_no_tmp_files(root: &Path) -> Result<(), Box<dyn Error>> {
    if !root.exists() {
        return Ok(());
    }
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            assert!(
                !name.ends_with(".tmp") && !name.contains(".tmp."),
                "atomic staging file must not remain: {}",
                path.display()
            );
        }
    }
    Ok(())
}

#[test]
fn explicit_readings_are_flattened_as_reading_surface_pairs() -> TestResult {
    let fixture = Fixture::new()?;
    seed_project(
        fixture.db(),
        "p-ja",
        "Pair Project",
        "ja",
        Some("Fantasy"),
        Some("二人の名前をめぐる物語"),
    )?;
    seed_entry(
        fixture.db(),
        "entry-pair",
        "p-ja",
        "character",
        "OO",
        Some(r#"["XX","SKIP","ヴァイオリン"]"#),
        Some(r#"["SKIP"]"#),
        Some(
            r#"{"OO":["oo","おーおー"],"XX":["xx"],"SKIP":["すきっぷ"],"ヴァイオリン":["ｳﾞｧｲｵﾘﾝ"],"ORPHAN":["こじ"]}"#,
        ),
        "always",
    )?;

    refresh_project_export(
        fixture.db(),
        &fixture.ime_root,
        "p-ja",
        &options(ImeIntegrationMode::On),
    )?;

    let snapshot = read_snapshot(&fixture.ime_root, "p-ja")?;
    assert_eq!(snapshot.format_version, 1);
    assert_eq!(snapshot.project_id, "p-ja");
    assert_eq!(snapshot.project_name, "Pair Project");

    let oo = find_entry(&snapshot, "entry-pair", "OO", "oo")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "OO/oo pair missing"))?;
    assert_eq!(oo.category, "person");
    assert_eq!(oo.priority, 2);
    assert!(find_entry(&snapshot, "entry-pair", "OO", "おーおー").is_some());
    assert!(find_entry(&snapshot, "entry-pair", "XX", "xx").is_some());
    assert!(
        find_entry(&snapshot, "entry-pair", "OO", "xx").is_none(),
        "alias reading must not be rebound to the Codex entry name"
    );
    assert!(
        find_entry(&snapshot, "entry-pair", "ヴァイオリン", "ゔぁいおりん").is_some(),
        "explicit readings must be NFKC-normalized and converted to hiragana"
    );
    assert!(snapshot.entries.iter().all(|entry| entry.surface != "SKIP"));
    assert!(snapshot
        .entries
        .iter()
        .all(|entry| entry.surface != "ORPHAN"));

    let profile = snapshot
        .profile
        .as_deref()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "profile missing"))?;
    assert!(profile.contains("二人の名前をめぐる物語"));
    assert!(profile.contains("OO"));
    Ok(())
}

#[test]
fn derives_readings_for_kana_and_maps_builtin_and_custom_categories() -> TestResult {
    let fixture = Fixture::new()?;
    seed_project(fixture.db(), "p-ja", "Kana", "ja", None, None)?;
    seed_entry(
        fixture.db(),
        "entry-person",
        "p-ja",
        "character",
        "サクラ",
        Some(r#"["ﾗｰﾒﾝ"]"#),
        None,
        None,
        "mentioned",
    )?;
    seed_entry(
        fixture.db(),
        "entry-place",
        "p-ja",
        "location",
        "トウキョウ",
        None,
        None,
        None,
        "mentioned",
    )?;
    seed_entry(
        fixture.db(),
        "entry-lore",
        "p-ja",
        "lore",
        "セカイ",
        None,
        None,
        None,
        "mentioned",
    )?;

    let mut export_options = options(ImeIntegrationMode::On);
    export_options.include_profile = false;
    refresh_project_export(fixture.db(), &fixture.ime_root, "p-ja", &export_options)?;

    let snapshot = read_snapshot(&fixture.ime_root, "p-ja")?;
    let person = find_entry(&snapshot, "entry-person", "サクラ", "さくら")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "kana name missing"))?;
    assert_eq!(person.category, "person");
    assert_eq!(person.priority, 1);
    assert!(find_entry(&snapshot, "entry-person", "ﾗｰﾒﾝ", "らーめん").is_some());
    assert_eq!(
        find_entry(&snapshot, "entry-place", "トウキョウ", "とうきょう")
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "place missing"))?
            .category,
        "place"
    );
    assert_eq!(
        find_entry(&snapshot, "entry-lore", "セカイ", "せかい")
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "lore missing"))?
            .category,
        "noun"
    );
    assert!(snapshot.profile.is_none());
    let raw = read_snapshot_value(&fixture.ime_root, "p-ja")?;
    assert!(
        raw.get("profile").is_none(),
        "disabled profile must be omitted rather than serialized as null"
    );
    Ok(())
}

#[test]
fn exclude_hidden_filters_hidden_and_suppress_entries_from_words_and_profile() -> TestResult {
    let fixture = Fixture::new()?;
    seed_project(
        fixture.db(),
        "p-ja",
        "Secrets",
        "ja",
        None,
        Some("秘密設定"),
    )?;
    for (id, name, reading, mode) in [
        ("visible", "アカリ", "あかり", "mentioned"),
        ("hidden", "ヒミツ", "ひみつ", "hidden"),
        ("suppress", "フセジ", "ふせじ", "suppress"),
    ] {
        seed_entry(
            fixture.db(),
            id,
            "p-ja",
            "character",
            name,
            None,
            None,
            Some(&format!(r#"{{"{name}":["{reading}"]}}"#)),
            mode,
        )?;
    }

    let mut export_options = options(ImeIntegrationMode::On);
    export_options.exclude_hidden = true;
    refresh_project_export(fixture.db(), &fixture.ime_root, "p-ja", &export_options)?;
    let filtered = read_snapshot(&fixture.ime_root, "p-ja")?;
    assert!(filtered
        .entries
        .iter()
        .any(|entry| entry.entry_id == "visible"));
    assert!(filtered
        .entries
        .iter()
        .all(|entry| entry.entry_id != "hidden"));
    assert!(filtered
        .entries
        .iter()
        .all(|entry| entry.entry_id != "suppress"));
    let profile = filtered
        .profile
        .as_deref()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "profile missing"))?;
    assert!(profile.contains("アカリ"));
    assert!(!profile.contains("ヒミツ"));
    assert!(!profile.contains("フセジ"));

    export_options.exclude_hidden = false;
    refresh_project_export(fixture.db(), &fixture.ime_root, "p-ja", &export_options)?;
    let unfiltered = read_snapshot(&fixture.ime_root, "p-ja")?;
    assert!(unfiltered
        .entries
        .iter()
        .any(|entry| entry.entry_id == "hidden"));
    assert!(unfiltered
        .entries
        .iter()
        .any(|entry| entry.entry_id == "suppress"));
    Ok(())
}

#[test]
fn non_japanese_project_removes_its_snapshot_and_clears_active_state() -> TestResult {
    let fixture = Fixture::new()?;
    seed_project(fixture.db(), "p-lang", "Language", "ja", None, None)?;
    seed_entry(
        fixture.db(),
        "entry-ja",
        "p-lang",
        "character",
        "サクラ",
        None,
        None,
        None,
        "mentioned",
    )?;
    refresh_project_export(
        fixture.db(),
        &fixture.ime_root,
        "p-lang",
        &options(ImeIntegrationMode::On),
    )?;
    set_active_project(&fixture.ime_root, Some("p-lang"), ImeIntegrationMode::On)?;
    assert_eq!(
        read_active_project(&fixture.ime_root)?,
        Some("p-lang".into())
    );

    fixture.db().with_conn(|conn| {
        conn.execute(
            "UPDATE projects SET language = 'en' WHERE id = 'p-lang'",
            [],
        )?;
        Ok(())
    })?;
    refresh_project_export(
        fixture.db(),
        &fixture.ime_root,
        "p-lang",
        &options(ImeIntegrationMode::On),
    )?;

    assert!(!project_snapshot_path(&fixture.ime_root, "p-lang").exists());
    assert_eq!(read_active_project(&fixture.ime_root)?, None);
    Ok(())
}

#[test]
fn auto_mode_requires_a_consumer_and_status_reports_effective_state() -> TestResult {
    let fixture = Fixture::new()?;
    seed_project(fixture.db(), "p-auto", "Auto", "ja", None, None)?;
    seed_entry(
        fixture.db(),
        "entry-auto",
        "p-auto",
        "character",
        "サクラ",
        None,
        None,
        None,
        "mentioned",
    )?;

    let status = serde_json::to_value(get_status(&fixture.ime_root, ImeIntegrationMode::Auto)?)?;
    assert!(!status_enabled(&status)?);
    assert_eq!(status_consumer_count(&status)?, 0);
    assert_eq!(status_output_dir(&status)?, fixture.ime_root);
    refresh_project_export(
        fixture.db(),
        &fixture.ime_root,
        "p-auto",
        &options(ImeIntegrationMode::Auto),
    )?;
    assert!(!project_snapshot_path(&fixture.ime_root, "p-auto").exists());

    let consumers = fixture.ime_root.join("consumers");
    fs::create_dir_all(&consumers)?;
    fs::write(
        consumers.join("test-ime.json"),
        br#"{"format_version":1,"consumer_id":"test-ime","name":"Test IME","version":"1.0.0","capabilities":{"profile":true},"last_seen":"2026-07-11T00:00:00.000Z"}"#,
    )?;
    let status = serde_json::to_value(get_status(&fixture.ime_root, ImeIntegrationMode::Auto)?)?;
    assert!(status_enabled(&status)?);
    assert_eq!(status_consumer_count(&status)?, 1);
    refresh_project_export(
        fixture.db(),
        &fixture.ime_root,
        "p-auto",
        &options(ImeIntegrationMode::Auto),
    )?;
    assert!(project_snapshot_path(&fixture.ime_root, "p-auto").exists());

    let off = serde_json::to_value(get_status(&fixture.ime_root, ImeIntegrationMode::Off)?)?;
    assert!(
        !status_enabled(&off)?,
        "off must override consumer detection"
    );
    Ok(())
}

#[test]
fn set_active_only_points_to_an_existing_snapshot() -> TestResult {
    let fixture = Fixture::new()?;
    seed_project(fixture.db(), "p-active", "Active", "ja", None, None)?;
    seed_entry(
        fixture.db(),
        "entry-active",
        "p-active",
        "character",
        "サクラ",
        None,
        None,
        None,
        "mentioned",
    )?;

    set_active_project(&fixture.ime_root, Some("missing"), ImeIntegrationMode::On)?;
    assert_eq!(read_active_project(&fixture.ime_root)?, None);

    refresh_project_export(
        fixture.db(),
        &fixture.ime_root,
        "p-active",
        &options(ImeIntegrationMode::On),
    )?;
    set_active_project(&fixture.ime_root, Some("p-active"), ImeIntegrationMode::On)?;
    assert_eq!(
        read_active_project(&fixture.ime_root)?,
        Some("p-active".into())
    );

    set_active_project(&fixture.ime_root, Some("p-active"), ImeIntegrationMode::Off)?;
    assert_eq!(read_active_project(&fixture.ime_root)?, None);
    Ok(())
}

#[test]
fn repeated_refresh_atomically_replaces_json_without_tmp_residue() -> TestResult {
    let fixture = Fixture::new()?;
    seed_project(fixture.db(), "p-atomic", "Atomic", "ja", None, None)?;
    seed_entry(
        fixture.db(),
        "entry-atomic",
        "p-atomic",
        "character",
        "サクラ",
        None,
        None,
        None,
        "mentioned",
    )?;
    let export_options = options(ImeIntegrationMode::On);
    refresh_project_export(fixture.db(), &fixture.ime_root, "p-atomic", &export_options)?;
    fixture.db().with_conn(|conn| {
        conn.execute(
            "UPDATE codex_entries
             SET readings = '{\"サクラ\":[\"さくらあたらしい\"]}'
             WHERE id = 'entry-atomic'",
            [],
        )?;
        Ok(())
    })?;
    refresh_project_export(fixture.db(), &fixture.ime_root, "p-atomic", &export_options)?;

    let snapshot = read_snapshot(&fixture.ime_root, "p-atomic")?;
    assert!(find_entry(&snapshot, "entry-atomic", "サクラ", "さくらあたらしい").is_some());
    assert_no_tmp_files(&fixture.ime_root)?;
    Ok(())
}

#[test]
fn clear_and_remove_preserve_consumers_and_keep_state_from_pointing_at_missing_files() -> TestResult
{
    let fixture = Fixture::new()?;
    for (id, title) in [("p-one", "One"), ("p-two", "Two")] {
        seed_project(fixture.db(), id, title, "ja", None, None)?;
        seed_entry(
            fixture.db(),
            &format!("entry-{id}"),
            id,
            "character",
            "サクラ",
            None,
            None,
            None,
            "mentioned",
        )?;
        refresh_project_export(
            fixture.db(),
            &fixture.ime_root,
            id,
            &options(ImeIntegrationMode::On),
        )?;
    }
    let consumer = fixture.ime_root.join("consumers").join("keep-me.json");
    fs::create_dir_all(consumer.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "consumer path has no parent")
    })?)?;
    fs::write(
        &consumer,
        br#"{"format_version":1,"consumer_id":"keep-me","name":"Keep Me","version":"1.0.0","capabilities":{"profile":false},"last_seen":"2026-07-11T00:00:00.000Z"}"#,
    )?;

    set_active_project(&fixture.ime_root, Some("p-one"), ImeIntegrationMode::On)?;
    remove_project_export(&fixture.ime_root, "p-one")?;
    assert!(!project_snapshot_path(&fixture.ime_root, "p-one").exists());
    assert!(project_snapshot_path(&fixture.ime_root, "p-two").exists());
    assert_eq!(read_active_project(&fixture.ime_root)?, None);
    assert!(consumer.exists());

    set_active_project(&fixture.ime_root, Some("p-two"), ImeIntegrationMode::On)?;
    clear_all_exports(&fixture.ime_root)?;
    assert!(!project_snapshot_path(&fixture.ime_root, "p-two").exists());
    assert_eq!(read_active_project(&fixture.ime_root)?, None);
    assert!(consumer.exists(), "clear must preserve the IME handshake");

    let status = serde_json::to_value(get_status(&fixture.ime_root, ImeIntegrationMode::Auto)?)?;
    assert!(status_enabled(&status)?);
    assert_eq!(status_consumer_count(&status)?, 1);
    Ok(())
}

#[test]
fn project_id_path_traversal_is_rejected_without_touching_state() -> TestResult {
    let fixture = Fixture::new()?;
    seed_project(fixture.db(), "safe", "Safe", "ja", None, None)?;
    seed_entry(
        fixture.db(),
        "entry-safe",
        "safe",
        "character",
        "サクラ",
        None,
        None,
        None,
        "mentioned",
    )?;
    refresh_project_export(
        fixture.db(),
        &fixture.ime_root,
        "safe",
        &options(ImeIntegrationMode::On),
    )?;
    set_active_project(&fixture.ime_root, Some("safe"), ImeIntegrationMode::On)?;

    let remove_result = remove_project_export(&fixture.ime_root, "../state");
    assert!(
        remove_result.is_err(),
        "remove must reject parent traversal"
    );
    assert_eq!(read_active_project(&fixture.ime_root)?, Some("safe".into()));
    assert!(project_snapshot_path(&fixture.ime_root, "safe").exists());

    seed_project(fixture.db(), "../escape", "Malicious", "ja", None, None)?;
    let refresh_result = refresh_project_export(
        fixture.db(),
        &fixture.ime_root,
        "../escape",
        &options(ImeIntegrationMode::On),
    );
    assert!(
        refresh_result.is_err(),
        "refresh must reject parent traversal"
    );
    assert!(!fixture.ime_root.join("escape.json").exists());
    assert_eq!(read_active_project(&fixture.ime_root)?, Some("safe".into()));
    Ok(())
}
