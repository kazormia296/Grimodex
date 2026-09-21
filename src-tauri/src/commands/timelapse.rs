//! Timelapse append commands.

use std::path::PathBuf;

use serde::Deserialize;

use crate::database::change_events::{AppendChangeEvent, AppendResult};
use grimodex_db::state::{active_workspace_snapshot, ActiveWorkspaceSnapshot};
use grimodex_db::timelapse::{
    TimelapseBodySnapshotTarget, TimelapseGenesisBaselineAppendSummary,
    TimelapseGenesisBaselineKind, TimelapseHistoryPurgeSummary,
    TimelapseLayoutSnapshotAppendSummary,
};

use super::{with_db, AppError, WorkspaceState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TimelapseBodyBaselineTarget {
    kind: String,
    id: String,
}

fn validate_workspace_binding(
    workspace: &ActiveWorkspaceSnapshot,
    expected_workspace_path: &str,
) -> Result<(), AppError> {
    if expected_workspace_path.is_empty()
        || expected_workspace_path.trim() != expected_workspace_path
        || expected_workspace_path.chars().count() > 16_384
    {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "TIMELAPSE_GENESIS_BASELINE_INVALID_WORKSPACE_PATH: expectedWorkspacePath must be exact, non-empty, and at most 16384 characters"
        )));
    }
    let active = workspace
        .path()
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    let expected = PathBuf::from(expected_workspace_path)
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    if active != expected {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "TIMELAPSE_GENESIS_BASELINE_WORKSPACE_CHANGED: expected {}, active {}",
            expected.display(),
            active.display()
        )));
    }
    Ok(())
}

fn authorized_workspace(
    ws_state: &tauri::State<'_, WorkspaceState>,
    expected_workspace_path: &str,
) -> Result<ActiveWorkspaceSnapshot, AppError> {
    let workspace = active_workspace_snapshot(ws_state)?;
    validate_workspace_binding(&workspace, expected_workspace_path)?;
    Ok(workspace)
}

#[tauri::command(async)]
pub(crate) fn timelapse_append_batch(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
    session_id: String,
    events: Vec<AppendChangeEvent>,
) -> Result<AppendResult, AppError> {
    with_db(&ws_state, |db| {
        db.append_renderer_change_events(&project_id, &session_id, &events)
    })
}

#[tauri::command(async)]
pub(crate) fn timelapse_genesis_baselines_append(
    ws_state: tauri::State<'_, WorkspaceState>,
    expected_workspace_path: String,
    project_id: String,
    kind: String,
    entity_ids: Vec<String>,
    anchor_timestamp: i64,
) -> Result<TimelapseGenesisBaselineAppendSummary, AppError> {
    let workspace = authorized_workspace(&ws_state, &expected_workspace_path)?;
    let kind = TimelapseGenesisBaselineKind::parse(&kind)?;
    Ok(workspace.db().append_timelapse_genesis_baselines(
        &project_id,
        kind,
        &entity_ids,
        anchor_timestamp,
    )?)
}

#[tauri::command(async)]
pub(crate) fn timelapse_body_baselines_append(
    ws_state: tauri::State<'_, WorkspaceState>,
    expected_workspace_path: String,
    project_id: String,
    targets: Vec<TimelapseBodyBaselineTarget>,
    expected_anchor_sequence: Option<i64>,
) -> Result<grimodex_db::timelapse::TimelapseBodyBaselineAppendSummary, AppError> {
    let workspace = authorized_workspace(&ws_state, &expected_workspace_path)?;
    let targets = targets
        .into_iter()
        .map(|target| {
            let kind = TimelapseGenesisBaselineKind::parse(&target.kind)?;
            Ok::<_, anyhow::Error>(match kind {
                TimelapseGenesisBaselineKind::Scene => {
                    TimelapseBodySnapshotTarget::scene(target.id)
                }
                TimelapseGenesisBaselineKind::Codex => {
                    TimelapseBodySnapshotTarget::codex(target.id)
                }
                TimelapseGenesisBaselineKind::Snippet => {
                    TimelapseBodySnapshotTarget::snippet(target.id)
                }
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(workspace.db().append_timelapse_body_baselines(
        &project_id,
        &targets,
        expected_anchor_sequence,
    )?)
}

#[tauri::command(async)]
pub(crate) fn timelapse_history_purge(
    ws_state: tauri::State<'_, WorkspaceState>,
    expected_workspace_path: String,
    project_id: String,
) -> Result<TimelapseHistoryPurgeSummary, AppError> {
    let workspace = authorized_workspace(&ws_state, &expected_workspace_path)?;
    Ok(workspace.db().purge_timelapse_history(&project_id)?)
}

#[tauri::command(async)]
pub(crate) fn timelapse_enabled_set(
    ws_state: tauri::State<'_, WorkspaceState>,
    expected_workspace_path: String,
    project_id: String,
    enabled: bool,
) -> Result<grimodex_db::timelapse::TimelapseEnabledSetSummary, AppError> {
    let workspace = authorized_workspace(&ws_state, &expected_workspace_path)?;
    Ok(workspace.db().set_timelapse_enabled(&project_id, enabled)?)
}

#[tauri::command(async)]
pub(crate) fn timelapse_layout_snapshot_record(
    ws_state: tauri::State<'_, WorkspaceState>,
    expected_workspace_path: String,
    project_id: String,
    payload: serde_json::Value,
    expected_anchor_sequence: Option<i64>,
) -> Result<TimelapseLayoutSnapshotAppendSummary, AppError> {
    let workspace = authorized_workspace(&ws_state, &expected_workspace_path)?;
    let payload = serde_json::to_string(&payload)
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    Ok(workspace.db().append_timelapse_layout_snapshot(
        &project_id,
        &payload,
        expected_anchor_sequence,
    )?)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Mutex;

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{
        get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
    };
    use tauri::webview::InvokeRequest;
    use tauri::WebviewWindowBuilder;

    use crate::database::{Database, WorkspaceAuthority};
    use grimodex_db::recovery::SafeModeState;
    use grimodex_db::state::{ActiveWorkspace, WorkspaceState};

    fn test_workspace_state() -> (WorkspaceState, String, PathBuf) {
        let workspace_path = std::env::temp_dir().join(format!(
            "grimodex-tauri-timelapse-parity-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&workspace_path).expect("create workspace directory");
        let db = Database::new(&workspace_path.join("grimodex.db")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('tauri-parity-project', 'Parity')",
                [],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
                 VALUES ('tauri-parity-scene', 'tauri-parity-project', 'scene', 'Scene', '{}')",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed parity workspace");
        let authority = WorkspaceAuthority::from_database_for_test(db, workspace_path.clone())
            .expect("acquire workspace authority");
        let expected_workspace_path = workspace_path.to_string_lossy().into_owned();
        (
            WorkspaceState {
                inner: Mutex::new(Some(ActiveWorkspace::new(authority))),
                safe_mode: SafeModeState::default(),
                switching: grimodex_db::WorkspaceLifecycleCompatibilityView::default(),
                open_lock: Mutex::new(()),
            },
            expected_workspace_path,
            workspace_path,
        )
    }

    fn invoke_json<W: AsRef<tauri::Webview<MockRuntime>>>(
        webview: &W,
        command: &str,
        args: Value,
    ) -> Value {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: command.to_string(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("valid test URL"),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .unwrap_or_else(|error| panic!("Tauri command {command} failed: {error}"))
        .deserialize::<Value>()
        .unwrap_or_else(|error| panic!("Tauri command {command} returned invalid JSON: {error}"))
    }

    #[test]
    fn typed_timelapse_commands_are_registered_and_exercised_through_tauri_ipc() {
        let (workspace_state, expected_workspace_path, workspace_path) = test_workspace_state();
        let app = mock_builder()
            .manage(workspace_state)
            .invoke_handler(tauri::generate_handler![
                timelapse_append_batch,
                timelapse_genesis_baselines_append,
                timelapse_body_baselines_append,
                timelapse_enabled_set,
                timelapse_history_purge,
                timelapse_layout_snapshot_record,
            ])
            .build(mock_context(noop_assets()))
            .expect("build Tauri parity app");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");
        let project_id = "tauri-parity-project";

        let append = invoke_json(
            &webview,
            "timelapse_append_batch",
            json!({
                "projectId": project_id,
                "sessionId": "tauri-parity-session",
                "events": [{
                    "eventUid": "tauri-parity-event",
                    "sceneId": "tauri-parity-scene",
                    "domain": "editor",
                    "opType": "scene.replace",
                    "entityType": "scene",
                    "entityId": "tauri-parity-scene",
                    "payload": "{}",
                    "timestamp": 100
                }]
            }),
        );
        assert_eq!(append["insertedCount"], 1);
        assert_eq!(append["tailSequence"], 1);

        let genesis = invoke_json(
            &webview,
            "timelapse_genesis_baselines_append",
            json!({
                "expectedWorkspacePath": expected_workspace_path.clone(),
                "projectId": project_id,
                "kind": "scene",
                "entityIds": ["tauri-parity-scene"],
                "anchorTimestamp": 100
            }),
        );
        assert_eq!(genesis["insertedCount"], 1);

        let body = invoke_json(
            &webview,
            "timelapse_body_baselines_append",
            json!({
                "expectedWorkspacePath": expected_workspace_path.clone(),
                "projectId": project_id,
                "targets": [{"kind": "scene", "id": "tauri-parity-scene"}],
                "expectedAnchorSequence": 1
            }),
        );
        assert_eq!(body["insertedCount"], 1);
        assert_eq!(body["anchorSequence"], 1);

        let layout = invoke_json(
            &webview,
            "timelapse_layout_snapshot_record",
            json!({
                "expectedWorkspacePath": expected_workspace_path.clone(),
                "projectId": project_id,
                "payload": {"layout": {}, "activePresetId": null, "hiddenStripePanels": []},
                "expectedAnchorSequence": 1
            }),
        );
        assert_eq!(layout["inserted"], true);

        let enabled = invoke_json(
            &webview,
            "timelapse_enabled_set",
            json!({
                "expectedWorkspacePath": expected_workspace_path.clone(),
                "projectId": project_id,
                "enabled": true
            }),
        );
        assert_eq!(enabled["enabled"], true);

        let purge = invoke_json(
            &webview,
            "timelapse_history_purge",
            json!({
                "expectedWorkspacePath": expected_workspace_path,
                "projectId": project_id
            }),
        );
        assert_eq!(purge["deletedEventCount"], 1);
        assert!(purge["deletedSnapshotCount"].as_i64().unwrap_or_default() >= 3);

        drop(webview);
        drop(app);
        std::fs::remove_dir_all(workspace_path).expect("remove parity workspace");
    }
}
