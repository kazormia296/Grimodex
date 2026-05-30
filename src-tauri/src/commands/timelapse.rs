//! Timelapse append commands.

use crate::database::change_events::{AppendChangeEvent, AppendResult};

use super::{with_db, AppError, WorkspaceState};

#[tauri::command]
pub(crate) fn timelapse_append_batch(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
    session_id: String,
    events: Vec<AppendChangeEvent>,
) -> Result<AppendResult, AppError> {
    with_db(&ws_state, |db| {
        db.append_change_events(&project_id, &session_id, &events)
    })
}
