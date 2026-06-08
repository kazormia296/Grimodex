mod ai;
mod ai_novelist;
mod cli_provider;
mod codex_matching;
mod commands;
mod database;
mod external_mount;
mod lint_logging;
mod semantic;
mod workspace;

use std::sync::{Arc, Mutex};
use tauri::Manager;

use codex_matching::CodexMatcherState;
use commands::external_mount::ExternalMountState;
#[cfg(feature = "semantic-embedding")]
use commands::semantic::SemanticEmbedderState;
use commands::{
    AiSettingsPath, CliStreamAbortFlag, GlobalSettingsPath, InlineAiAbortFlag, LogGuard,
    PostEffectAbortFlag, StreamAbortFlag, WorkspaceState,
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
            app.manage(GlobalSettingsPath { path: gs_path });

            // AI settings path (stays in AppData)
            let ai_path = app_dir.join("ai-settings.json");
            app.manage(AiSettingsPath { path: ai_path });

            // Workspace state starts empty — frontend will call open_workspace
            app.manage(WorkspaceState {
                inner: Mutex::new(None),
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

            // Semantic search: ruri-v3 ONNX Embedder. Lazy load on first invoke.
            #[cfg(feature = "semantic-embedding")]
            app.manage(SemanticEmbedderState {
                inner: std::sync::Mutex::new(None),
            });

            // Semantic search: in-memory embedding cache (scene_id -> Vec<f32>).
            // Cleared on workspace open; invalidated per-scene on index_scene.
            app.manage(semantic::search::SearchCache::new());

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
            commands::agent_writes::agent_propose_scene_body,
            commands::agent_writes::agent_accept_prose_stage,
            commands::agent_writes::agent_discard_prose_stage,
            commands::agent_writes::agent_apply_undo_journal,
            commands::ai::get_ai_settings,
            commands::ai::save_ai_settings,
            commands::ai::save_api_key,
            commands::ai::get_api_key,
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
            commands::semantic::semantic_chunk_context,
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
