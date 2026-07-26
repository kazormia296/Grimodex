//! One-shot Tauri keyring export for Electron v2 migration.
//!
//! This module is compiled only for the explicitly opted-in release feature.
//! It reads legacy credentials but never deletes them, preserving rollback to
//! the final Tauri build. Renderer command dispatch has no mapping for it.

use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::Path;

use anyhow::Context;
use grimodex_ai::{AiProvider, AiSettings};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyApiKeyEntry {
    pub provider: String,
    pub endpoint_id: Option<String>,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyApiKeyExport {
    pub available: bool,
    pub entries: Vec<LegacyApiKeyEntry>,
}

fn credential_candidates(settings: &AiSettings) -> Vec<(AiProvider, Option<String>)> {
    let mut candidates = vec![
        (AiProvider::OpenRouter, None),
        (AiProvider::OpenAI, None),
        (AiProvider::Anthropic, None),
        (AiProvider::Ollama, None),
        (AiProvider::Sakana, None),
        (AiProvider::AiNovelist, None),
        (AiProvider::Cli, None),
        // Preserve the legacy `grimodex-user` account even when the current
        // settings contain only newly named endpoint ids.
        (AiProvider::OpenaiCompatible, None),
    ];
    let mut seen_endpoint_ids = HashSet::new();
    for endpoint in &settings.openai_compatible_endpoints {
        if !endpoint.id.is_empty() && seen_endpoint_ids.insert(endpoint.id.clone()) {
            candidates.push((AiProvider::OpenaiCompatible, Some(endpoint.id.clone())));
        }
    }
    candidates
}

fn collect_legacy_api_keys(
    settings: &AiSettings,
    mut lookup: impl FnMut(&AiProvider, Option<&str>) -> anyhow::Result<Option<String>>,
) -> anyhow::Result<Vec<LegacyApiKeyEntry>> {
    let mut entries = Vec::new();
    for (provider, endpoint_id) in credential_candidates(settings) {
        if let Some(key) = lookup(&provider, endpoint_id.as_deref())? {
            entries.push(LegacyApiKeyEntry {
                provider: provider.to_string(),
                endpoint_id,
                key,
            });
        }
    }
    Ok(entries)
}

fn read_ai_settings_for_migration(path: &Path) -> anyhow::Result<AiSettings> {
    let mut settings = match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str::<AiSettings>(&content)
            .with_context(|| format!("legacy AI settings are invalid: {}", path.display()))?,
        Err(error) if error.kind() == ErrorKind::NotFound => AiSettings::default(),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("legacy AI settings cannot be read: {}", path.display()));
        }
    };
    settings.normalize_openai_compatible();
    Ok(settings)
}

pub fn read_legacy_api_keys(settings_path: &Path) -> anyhow::Result<LegacyApiKeyExport> {
    // The normal application reader intentionally defaults on malformed files.
    // Migration must be stricter: otherwise custom endpoint ids disappear and
    // the one-shot marker permanently prevents their credentials being retried.
    let settings = read_ai_settings_for_migration(settings_path)?;
    let entries = collect_legacy_api_keys(&settings, grimodex_ai::get_api_key)?;
    Ok(LegacyApiKeyExport {
        available: true,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimodex_ai::{OpenaiCompatibleEndpoint, LEGACY_OPENAI_COMPAT_ENDPOINT_ID};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temporary_path(label: &str) -> std::path::PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "grimodex-node-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn candidates_cover_fixed_providers_legacy_account_and_unique_endpoints() {
        let settings = AiSettings {
            openai_compatible_endpoints: vec![
                OpenaiCompatibleEndpoint {
                    id: LEGACY_OPENAI_COMPAT_ENDPOINT_ID.to_string(),
                    ..OpenaiCompatibleEndpoint::default()
                },
                OpenaiCompatibleEndpoint {
                    id: "custom".to_string(),
                    ..OpenaiCompatibleEndpoint::default()
                },
                OpenaiCompatibleEndpoint {
                    id: "custom".to_string(),
                    ..OpenaiCompatibleEndpoint::default()
                },
            ],
            ..AiSettings::default()
        };
        let candidates = credential_candidates(&settings);
        assert_eq!(candidates.len(), 10);
        assert!(candidates.contains(&(AiProvider::OpenRouter, None)));
        assert!(candidates.contains(&(AiProvider::Cli, None)));
        assert!(candidates.contains(&(AiProvider::OpenaiCompatible, None)));
        assert!(candidates.contains(&(
            AiProvider::OpenaiCompatible,
            Some(LEGACY_OPENAI_COMPAT_ENDPOINT_ID.to_string())
        )));
        assert!(candidates.contains(&(AiProvider::OpenaiCompatible, Some("custom".to_string()))));
    }

    #[test]
    fn collection_skips_missing_entries_and_preserves_endpoint_identity() {
        let settings = AiSettings {
            openai_compatible_endpoints: vec![OpenaiCompatibleEndpoint {
                id: "endpoint-a".to_string(),
                ..OpenaiCompatibleEndpoint::default()
            }],
            ..AiSettings::default()
        };
        let keys = HashMap::from([
            (("openai".to_string(), None), "openai-key".to_string()),
            (
                (
                    "openai-compatible".to_string(),
                    Some("endpoint-a".to_string()),
                ),
                "endpoint-key".to_string(),
            ),
        ]);

        let entries = collect_legacy_api_keys(&settings, |provider, endpoint_id| {
            Ok(keys
                .get(&(provider.to_string(), endpoint_id.map(str::to_string)))
                .cloned())
        })
        .expect("collect fixture keys");

        assert_eq!(
            entries,
            vec![
                LegacyApiKeyEntry {
                    provider: "openai".to_string(),
                    endpoint_id: None,
                    key: "openai-key".to_string(),
                },
                LegacyApiKeyEntry {
                    provider: "openai-compatible".to_string(),
                    endpoint_id: Some("endpoint-a".to_string()),
                    key: "endpoint-key".to_string(),
                },
            ]
        );
    }

    #[test]
    fn collection_aborts_without_partial_export_on_keyring_error() {
        let settings = AiSettings::default();
        let error = collect_legacy_api_keys(&settings, |provider, _| {
            if matches!(provider, AiProvider::Anthropic) {
                anyhow::bail!("locked keyring")
            }
            Ok(Some("key".to_string()))
        })
        .expect_err("one keyring failure must fail the whole export");
        assert!(error.to_string().contains("locked keyring"));
    }

    #[test]
    fn migration_settings_default_only_when_the_file_is_missing() {
        let path = temporary_path("missing-ai-settings.json");
        let _ = std::fs::remove_file(&path);

        let settings = read_ai_settings_for_migration(&path).expect("missing settings default");

        assert_eq!(settings.provider, AiSettings::default().provider);
    }

    #[test]
    fn migration_settings_reject_invalid_json_instead_of_losing_endpoint_ids() {
        let path = temporary_path("invalid-ai-settings.json");
        std::fs::write(&path, "{ not valid json").expect("write invalid settings");

        let error = read_ai_settings_for_migration(&path).expect_err("invalid settings must fail");

        let _ = std::fs::remove_file(&path);
        assert!(error.to_string().contains("legacy AI settings are invalid"));
    }

    #[test]
    fn migration_settings_reject_unreadable_paths_instead_of_defaulting() {
        let path = temporary_path("ai-settings-directory");
        std::fs::create_dir(&path).expect("create unreadable settings fixture");

        let error = read_ai_settings_for_migration(&path).expect_err("directory read must fail");

        let _ = std::fs::remove_dir(&path);
        assert!(error
            .to_string()
            .contains("legacy AI settings cannot be read"));
    }
}
