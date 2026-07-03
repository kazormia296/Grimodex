mod ai;
mod ai_novelist;
mod ai_responses;
mod cli_provider;
mod codex_matching;
mod commands;
mod database;
mod external_mount;
mod license;
mod lint_logging;
mod semantic;
mod workspace;

use std::sync::{Arc, Mutex};
use tauri::Manager;

use codex_matching::CodexMatcherState;
use commands::external_mount::ExternalMountState;
#[cfg(feature = "semantic-embedding")]
use commands::semantic::{ModelDownloadState, SemanticEmbedderState};
use commands::{
    AiSettingsPath, CliStreamAbortFlag, GlobalSettingsPath, InlineAiAbortFlag, LicensePath,
    LogGuard, PostEffectAbortFlag, StreamAbortFlag, WorkspaceState,
};
use external_mount::watch::ExternalMountWatchState;

#[tauri::command]
fn set_window_vibrancy(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial};

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window was not found".to_string())?;

        if enabled {
            apply_vibrancy(
                &window,
                NSVisualEffectMaterial::UnderWindowBackground,
                None,
                None,
            )
            .map_err(|error| error.to_string())?;
        } else {
            clear_vibrancy(&window).map_err(|error| error.to_string())?;
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled);
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Daily-rotating file log under `~/.grimodex/logs/lint-tauri-*.log`
    // plus stderr. The guard must outlive `tauri::Builder::run` so file
    // writes are flushed; stash it on the manager state.
    let log_guard = lint_logging::init_tauri_logging();

    let mut builder = tauri::Builder::default();
    if let Some(guard) = log_guard {
        builder = builder.manage(LogGuard(guard));
    }
    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("failed to get app data dir");
            std::fs::create_dir_all(&app_dir).ok();

            // Global settings path (stays in AppData)
            let gs_path = app_dir.join("global-settings.json");
            app.manage(GlobalSettingsPath {
                path: gs_path,
                write_lock: Mutex::new(()),
            });

            // AI settings path (stays in AppData)
            let ai_path = app_dir.join("ai-settings.json");
            app.manage(AiSettingsPath { path: ai_path });

            // License file path (stays in AppData, alongside global-settings.json)
            let license_path = app_dir.join("license.json");
            app.manage(LicensePath {
                path: license_path,
                write_lock: Mutex::new(()),
                validate_in_flight: std::sync::atomic::AtomicBool::new(false),
            });

            // ライセンスのバックグラウンド再検証 (ライセンス認証設計書 §5.4)。
            // 起動直後 + 6 時間ごとに「最終検証から 7 日以上」をチェックして
            // validate を投げ、結果を license:state_changed イベントで push する。
            // licensing feature 無効ビルドではサイクル先頭で即 return する。
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // 起動処理 (workspace open 等) との競合を避けて少し待つ。
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    loop {
                        commands::license::run_validate_cycle(&handle).await;
                        tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
                    }
                });
            }

            // Workspace state starts empty — frontend will call open_workspace
            app.manage(WorkspaceState {
                inner: Mutex::new(None),
                switching: std::sync::atomic::AtomicBool::new(false),
                open_lock: Mutex::new(()),
            });

            // Codex matcher state (rebuilt on demand via codex_rebuild_matcher)
            app.manage(CodexMatcherState {
                inner: Mutex::new(None),
            });

            // Stream abort flag
            app.manage(StreamAbortFlag {
                flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });

            // Inline AI abort flag (separate from chat's flag)
            app.manage(InlineAiAbortFlag {
                flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });

            // CLI provider stream abort flag (subprocess based, separate from HTTP streams)
            app.manage(CliStreamAbortFlag {
                flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });

            // PostEffect run abort flag
            app.manage(PostEffectAbortFlag {
                flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });

            // Semantic search: per-language ONNX Embedders (ja=ruri / en=...).
            // Lazy load on first invoke, keyed by model dir name.
            #[cfg(feature = "semantic-embedding")]
            app.manage(SemanticEmbedderState {
                inner: std::sync::Mutex::new(std::collections::HashMap::new()),
            });

            // オンデマンドモデル DL の in-flight 集合 (二重 DL ガード)。
            #[cfg(feature = "semantic-embedding")]
            app.manage(ModelDownloadState::default());

            // Semantic search: in-memory embedding cache (scene_id -> Vec<f32>).
            // Cleared on workspace open; invalidated per-scene on index_scene.
            app.manage(semantic::search::SearchCache::new());
            // Codex semantic search cache (entry_id -> embedding). Same lifecycle:
            // cleared on workspace open, invalidated per-entry on codex_index_entry.
            // Non-gated so workspace.rs (also non-gated) can clear it.
            app.manage(semantic::codex_search::CodexSearchCache::new());
            // Chronicle event semantic search cache (event_id -> embedding). Same
            // lifecycle: cleared on workspace open, invalidated per-event on
            // events_index_entry. Non-gated so workspace.rs can clear it.
            app.manage(semantic::events_search::EventsSearchCache::new());
            // Chat episodic recall cache (message_id -> embedding). Same lifecycle:
            // cleared on workspace open, invalidated per-message on chat_index_message.
            app.manage(semantic::chat_search::ChatSearchCache::new());

            app.manage(ExternalMountWatchState::new());
            app.manage(ExternalMountState::new());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_window_vibrancy,
            commands::workspace::get_global_settings,
            commands::workspace::save_global_settings,
            commands::workspace::validate_workspace_path,
            commands::workspace::open_workspace,
            commands::workspace::get_mcp_config,
            // ライセンス: licensing feature 無効でも常時登録 (get_license_state が
            // licensing_enabled:false を返す契約。cfg で消すとフロントが invoke 不能)
            commands::license::get_license_state,
            commands::license::activate_license,
            commands::license::revalidate_license,
            commands::license::deactivate_license,
            commands::export::export_save_text,
            commands::export::export_save_bytes,
            commands::fonts::list_system_fonts,
            commands::db::db_execute,
            commands::db::db_execute_batch,
            commands::timelapse::timelapse_append_batch,
            commands::agent_writes::agent_codex_create,
            commands::agent_writes::agent_codex_update,
            commands::agent_writes::agent_write_bundle,
            commands::agent_writes::agent_snippet_create,
            commands::agent_writes::agent_foreshadow_create,
            commands::agent_writes::agent_foreshadow_update,
            commands::agent_writes::agent_propose_scene_body,
            commands::agent_writes::agent_accept_prose_stage,
            commands::agent_writes::agent_discard_prose_stage,
            commands::agent_writes::agent_apply_undo_journal,
            commands::agent_writes::agent_event_create,
            commands::agent_writes::agent_event_update,
            commands::agent_writes::agent_event_delete,
            commands::agent_writes::agent_event_set_participants,
            commands::agent_writes::agent_scene_event_link,
            commands::agent_writes::agent_scene_event_unlink,
            commands::agent_writes::agent_event_relation_add,
            commands::agent_writes::agent_event_relation_remove,
            commands::ai::get_ai_settings,
            commands::ai::save_ai_settings,
            commands::ai::save_api_key,
            commands::ai::has_api_key,
            commands::ai::delete_api_key,
            commands::ai::list_ai_models,
            commands::ai::test_ai_connection,
            commands::ai::send_chat_message,
            commands::ai::send_chat_message_stream,
            commands::ai::abort_chat_stream,
            commands::ai::send_inline_ai_stream,
            commands::ai::abort_inline_ai_stream,
            commands::ai::send_agent_message,
            commands::cli_ai::detect_cli_binary,
            commands::cli_ai::test_cli_connection,
            commands::cli_ai::list_cli_models,
            commands::cli_ai::abort_cli_chat_stream,
            commands::cli_ai::send_cli_chat_stream,
            commands::foreshadow::foreshadow_create,
            commands::foreshadow::foreshadow_update,
            commands::foreshadow::foreshadow_delete,
            commands::foreshadow::foreshadow_list,
            commands::foreshadow::foreshadow_list_with_labels,
            commands::foreshadow::foreshadow_list_open_for_context,
            commands::foreshadow::foreshadow_get_scene_info,
            commands::foreshadow::foreshadow_get_scene_context,
            commands::foreshadow::foreshadow_list_by_codex_entry,
            commands::foreshadow::foreshadow_get_chapter_stats,
            commands::foreshadow::foreshadow_get_setup,
            commands::foreshadow::foreshadow_update_setup,
            commands::foreshadow::foreshadow_get,
            commands::foreshadow::foreshadow_link_codex,
            commands::foreshadow::foreshadow_unlink_codex,
            commands::foreshadow::foreshadow_list_linked_codex,
            commands::foreshadow::foreshadow_set_setup_strength,
            commands::foreshadow::foreshadow_resolve_orphan,
            commands::foreshadow::foreshadow_setup_create_ai,
            commands::foreshadow::foreshadow_save_anchors_for_scene,
            commands::foreshadow::foreshadow_load_anchors_for_scene,
            commands::integrity::fts_optimize,
            commands::integrity::fts_rebuild,
            commands::integrity::fts_rebuild_en,
            commands::integrity::fts_search,
            commands::integrity::integrity_check,
            commands::integrity::repair_integrity,
            commands::trash_bin::trash_bin_create,
            commands::trash_bin::trash_bin_list,
            commands::trash_bin::trash_bin_delete,
            commands::trash_bin::trash_bin_clear_all,
            commands::trash_bin::trash_bin_prune,
            codex_matching::codex_rebuild_matcher,
            codex_matching::codex_match_text,
            commands::codex_candidates::extract_codex_candidates,
            commands::plot_threads::plot_thread_create,
            commands::plot_threads::plot_thread_update,
            commands::plot_threads::plot_thread_delete,
            commands::plot_threads::plot_thread_list,
            commands::plot_threads::plot_thread_link_create,
            commands::plot_threads::plot_thread_link_update,
            commands::plot_threads::plot_thread_link_delete,
            commands::plot_threads::plot_thread_list_links,
            commands::lint::lint_text,
            commands::post_effect::start_post_effect_run,
            commands::post_effect::start_post_effect_run_multi,
            commands::post_effect::abort_post_effect_run,
            commands::post_effect::list_post_effect_runs,
            commands::post_effect::get_post_effect_run,
            commands::post_effect::list_scene_lens_for_project,
            commands::post_effect::list_annotations_for_scene,
            commands::post_effect::list_annotations_for_project,
            commands::post_effect::update_annotation_status,
            commands::post_effect::update_relation_status,
            commands::post_effect::reply_to_annotation,
            commands::post_effect::save_post_effect_annotations,
            commands::onboarding::seed_sample_workspace,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::semantic_index_scene,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::semantic_search,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::semantic_index_status,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::semantic_reindex_all,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::semantic_download_model,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::semantic_chunk_context,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::semantic_debug_dump,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::codex_semantic_search,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::codex_index_entry,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::codex_index_status,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::codex_reindex_all,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::events_index_entry,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::events_semantic_search,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::events_index_status,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::events_reindex_all,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::chat_index_message,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::chat_message_search,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::chat_index_status,
            #[cfg(feature = "semantic-embedding")]
            commands::semantic::chat_reindex_all,
            commands::external_mount::external_mount_register,
            commands::external_mount::external_mount_unregister,
            commands::external_mount::external_mount_read_file,
            commands::external_mount::external_mount_write_file,
            commands::external_mount::external_mount_file_mtime,
            commands::external_mount::external_mount_list,
            commands::external_mount::external_mount_scan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
