use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier, Mutex};
use std::time::Duration;

use grimodex_db::sample_seed::seed_sample_workspace;
use grimodex_db::workspace::{self, GlobalSettings, WorkspaceMeta};
use grimodex_db::{Database, GlobalSettingsPath};
use serde_json::Value;

const JA_SEED: &str = include_str!("../../../resources/sample_project/v2.json");
const EN_SEED: &str = include_str!("../../../resources/sample_project/v2_en.json");
const JA_SEED_EXTRA: &str = include_str!("../../../resources/sample_project/v2.sql");
const EN_SEED_EXTRA: &str = include_str!("../../../resources/sample_project/v2_en.sql");

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("grimodex_sample_seed_e2e_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp app-data directory");
        Self(path)
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn array_len(seed: &Value, key: &str) -> i64 {
    seed[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} must be an array"))
        .len() as i64
}

fn assert_seeded_database(
    db_path: &Path,
    seed_src: &str,
    extra_seed_src: &str,
    language: &str,
    ai_policy: &str,
) {
    let seed: Value = serde_json::from_str(seed_src).expect("parse embedded seed");
    let extra_tree_node_count = extra_seed_src.matches("INSERT INTO tree_nodes").count() as i64;
    let db = Database::new(db_path).expect("open seeded database");
    db.with_conn(|conn| {
        let project: (String, String, i64) = conn.query_row(
            "SELECT language, ai_policy, is_sample FROM projects WHERE id = 'default-project'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(project, (language.to_string(), ai_policy.to_string(), 1));

        let project_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
        assert_eq!(project_count, 1, "fresh database must contain one project");

        for (table, seed_key) in [
            ("tree_nodes", "tree_nodes"),
            ("codex_entries", "codex_entries"),
            ("chat_sessions", "chat_sessions"),
            ("chat_messages", "chat_messages"),
            ("foreshadows", "foreshadows"),
            ("snippets", "snippets"),
            ("foreshadow_setups", "foreshadow_setups"),
            ("authorship_spans", "authorship_spans"),
        ] {
            let count: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            let expected_count = if table == "tree_nodes" {
                array_len(&seed, seed_key) + extra_tree_node_count
            } else {
                array_len(&seed, seed_key)
            };
            assert_eq!(count, expected_count, "{table}");
        }

        let char_count: i64 = conn.query_row(
            "SELECT char_count FROM tree_nodes WHERE id = 'sample-scene-1'",
            [],
            |row| row.get(0),
        )?;
        assert!(char_count > 0, "scene body char_count must be populated");

        let ai_length: i64 = conn.query_row(
            "SELECT COALESCE(SUM(to_pos - from_pos), 0) FROM authorship_spans WHERE source = 'ai'",
            [],
            |row| row.get(0),
        )?;
        assert!(ai_length > 0, "AI authorship spans must be populated");
        Ok(())
    })
    .expect("verify seeded database");
}

#[test]
fn seed_sample_workspace_publishes_fresh_end_to_end_generations() {
    let temp = TempRoot::new();
    let settings_path = temp.0.join("global-settings.json");
    workspace::write_global_settings(
        &settings_path,
        &GlobalSettings {
            theme: "dark".to_string(),
            ..GlobalSettings::default()
        },
    )
    .expect("write initial global settings");
    let global_settings = GlobalSettingsPath {
        path: settings_path.clone(),
        write_lock: Mutex::new(()),
    };

    let en_policy = r#"{"preset":"full","toggles":{"chat":true}}"#;
    let first = seed_sample_workspace(&global_settings, "en", en_policy)
        .expect("seed English sample workspace");
    let first_workspace = PathBuf::from(&first.path);
    assert_eq!(first_workspace.parent(), Some(temp.0.as_path()));
    assert!(first_workspace
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("sample-workspace-")));
    assert_eq!(first.project_id, "default-project");
    assert_seeded_database(
        &first_workspace.join("grimodex.db"),
        EN_SEED,
        EN_SEED_EXTRA,
        "en",
        en_policy,
    );

    let metadata: WorkspaceMeta = serde_json::from_str(
        &std::fs::read_to_string(first_workspace.join(".grimodex/workspace.json"))
            .expect("read workspace metadata"),
    )
    .expect("parse workspace metadata");
    assert!(!metadata.id.is_empty());
    assert!(!metadata.created_at.is_empty());

    let settings = workspace::read_global_settings(&settings_path);
    assert_eq!(settings.theme, "dark", "unrelated settings must survive");
    assert_eq!(
        settings.sample_workspace_path.as_deref(),
        Some(first.path.as_str())
    );

    {
        let db = Database::new(&first_workspace.join("grimodex.db"))
            .expect("open sample database for stale marker");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('sample.seed.stale', '1')",
                [],
            )?;
            Ok(())
        })
        .expect("write stale marker");
    }

    // Language selection is intentionally exact: only lowercase `en` selects
    // the English seed; every unsupported value falls back to Japanese.
    let fallback_policy = r#"{"preset":"assist","toggles":{"chat":false}}"#;
    let second = seed_sample_workspace(&global_settings, "EN", fallback_policy)
        .expect("reseed fallback sample workspace");
    assert_ne!(second.path, first.path);
    let second_workspace = PathBuf::from(&second.path);
    assert_seeded_database(
        &second_workspace.join("grimodex.db"),
        JA_SEED,
        JA_SEED_EXTRA,
        "ja",
        fallback_policy,
    );

    let old_db = Database::new(&first_workspace.join("grimodex.db"))
        .expect("old published generation remains openable");
    let stale_count = old_db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = 'sample.seed.stale'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(anyhow::Error::from)
        })
        .expect("old generation remains untouched");
    assert_eq!(stale_count, 1);

    let settings = workspace::read_global_settings(&settings_path);
    assert_eq!(settings.theme, "dark");
    assert_eq!(
        settings.sample_workspace_path.as_deref(),
        Some(second.path.as_str())
    );
}

#[test]
fn seed_never_unlinks_a_previously_published_generation() {
    let temp = TempRoot::new();
    let settings_path = temp.0.join("global-settings.json");
    let global_settings = GlobalSettingsPath {
        path: settings_path,
        write_lock: Mutex::new(()),
    };
    let first = seed_sample_workspace(&global_settings, "en", r#"{"slot":1}"#)
        .expect("seed first generation");
    let second = seed_sample_workspace(&global_settings, "ja", r#"{"slot":2}"#)
        .expect("seed second generation");
    let third = seed_sample_workspace(&global_settings, "en", r#"{"slot":3}"#)
        .expect("seed third generation");
    assert_ne!(first.path, second.path);
    assert_ne!(second.path, third.path);
    assert_ne!(first.path, third.path);

    assert_seeded_database(
        &PathBuf::from(&first.path).join("grimodex.db"),
        EN_SEED,
        EN_SEED_EXTRA,
        "en",
        r#"{"slot":1}"#,
    );
    assert_seeded_database(
        &PathBuf::from(&second.path).join("grimodex.db"),
        JA_SEED,
        JA_SEED_EXTRA,
        "ja",
        r#"{"slot":2}"#,
    );
    assert_seeded_database(
        &PathBuf::from(&third.path).join("grimodex.db"),
        EN_SEED,
        EN_SEED_EXTRA,
        "en",
        r#"{"slot":3}"#,
    );
}

#[cfg(unix)]
#[test]
fn failed_unpublished_generation_is_removed() {
    use std::os::unix::ffi::OsStringExt;

    let temp = TempRoot::new();
    let app_dir = temp
        .0
        .join(std::ffi::OsString::from_vec(b"non-utf8-\xff".to_vec()));
    std::fs::create_dir_all(&app_dir).expect("create non-UTF-8 app-data directory");
    let global_settings = GlobalSettingsPath {
        path: app_dir.join("global-settings.json"),
        write_lock: Mutex::new(()),
    };

    let error = seed_sample_workspace(&global_settings, "en", r#"{"preset":"full"}"#)
        .expect_err("non-UTF-8 published paths are not representable on the IPC wire");
    assert!(error.to_string().contains("Non-UTF-8 workspace path"));
    let generations = std::fs::read_dir(&app_dir)
        .expect("list app-data directory")
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("sample-workspace-")
        })
        .count();
    assert_eq!(
        generations, 0,
        "failed unpublished generation must be cleaned"
    );
}

#[test]
fn seed_waits_for_the_shared_write_lock_before_touching_the_workspace() {
    let temp = TempRoot::new();
    let settings_path = temp.0.join("global-settings.json");
    let global_settings = Arc::new(GlobalSettingsPath {
        path: settings_path,
        write_lock: Mutex::new(()),
    });
    let guard = global_settings
        .write_lock
        .lock()
        .expect("hold global-settings write lock");
    let worker_settings = Arc::clone(&global_settings);
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        started_tx.send(()).expect("signal worker start");
        seed_sample_workspace(worker_settings.as_ref(), "en", r#"{"preset":"full"}"#)
    });

    started_rx.recv().expect("worker started");
    std::thread::sleep(Duration::from_millis(100));
    let generation_exists = std::fs::read_dir(&temp.0)
        .expect("list temp root")
        .flatten()
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("sample-workspace-")
        });
    assert!(
        !generation_exists,
        "the shared lock must cover DB creation, not only the final settings write"
    );

    drop(guard);
    let result = worker
        .join()
        .expect("seed worker must not panic")
        .expect("seed after releasing the lock");
    assert!(Path::new(&result.path).exists());
}

#[test]
fn concurrent_seed_requests_leave_one_coherent_seed_generation() {
    let temp = TempRoot::new();
    let settings_path = temp.0.join("global-settings.json");
    let global_settings = Arc::new(GlobalSettingsPath {
        path: settings_path.clone(),
        write_lock: Mutex::new(()),
    });
    let barrier = Arc::new(Barrier::new(3));

    let spawn_seed = |language: &'static str, policy: &'static str| {
        let worker_settings = Arc::clone(&global_settings);
        let worker_barrier = Arc::clone(&barrier);
        std::thread::spawn(move || {
            worker_barrier.wait();
            seed_sample_workspace(worker_settings.as_ref(), language, policy)
        })
    };
    let en_policy = r#"{"preset":"full","request":"en"}"#;
    let ja_policy = r#"{"preset":"assist","request":"ja"}"#;
    let en_worker = spawn_seed("en", en_policy);
    let ja_worker = spawn_seed("ja", ja_policy);
    barrier.wait();

    let en_result = en_worker
        .join()
        .expect("English seed worker must not panic")
        .expect("English seed must succeed");
    let ja_result = ja_worker
        .join()
        .expect("Japanese seed worker must not panic")
        .expect("Japanese seed must succeed");
    assert_ne!(en_result.path, ja_result.path);
    assert_eq!(en_result.project_id, ja_result.project_id);
    assert_seeded_database(
        &PathBuf::from(&en_result.path).join("grimodex.db"),
        EN_SEED,
        EN_SEED_EXTRA,
        "en",
        en_policy,
    );
    assert_seeded_database(
        &PathBuf::from(&ja_result.path).join("grimodex.db"),
        JA_SEED,
        JA_SEED_EXTRA,
        "ja",
        ja_policy,
    );

    let settings = workspace::read_global_settings(&settings_path);
    assert!(
        matches!(
            settings.sample_workspace_path.as_deref(),
            Some(path) if path == en_result.path || path == ja_result.path
        ),
        "settings must point to one fully committed generation"
    );
}
