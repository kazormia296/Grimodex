//! Plot thread (Plottr 型プロットスレッド) Tauri commands.
//!
//! `plot_threads` = タイムライン上の名前付き横レーン、
//! `plot_thread_scene_links` = スレッドが特定シーンで踏む段階マーカー。
//! schema は src-tauri/src/database/migrate.rs と src/db/schema.ts でミラー。

use serde_json::Value;

use crate::database;

use super::{with_db, AppError, WorkspaceState};

const PHASE_TYPES: [&str; 5] = ["introduce", "develop", "turn", "climax", "resolve"];

fn validate_phase(p: &str) -> anyhow::Result<()> {
    if PHASE_TYPES.contains(&p) {
        Ok(())
    } else {
        Err(anyhow::anyhow!("invalid phase_type: {p:?}"))
    }
}

fn one(rows: Vec<serde_json::Map<String, Value>>) -> Value {
    rows.first()
        .cloned()
        .map(Value::Object)
        .unwrap_or(Value::Null)
}

// ─────────────────────── DTO ───────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlotThreadCreatePayload {
    project_id: String,
    name: String,
    color: Option<String>,
    description: Option<String>,
    sort_order: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlotThreadPatch {
    name: Option<String>,
    color: Option<Option<String>>,
    description: Option<Option<String>>,
    sort_order: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlotThreadLinkCreatePayload {
    thread_id: String,
    node_id: String,
    phase_type: String,
    note: Option<String>,
    sort_order: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlotThreadLinkPatch {
    node_id: Option<String>,
    phase_type: Option<String>,
    note: Option<Option<String>>,
    sort_order: Option<Option<String>>,
}

// ─────────────────────── thread CRUD ───────────────────────

fn plot_thread_create_impl(
    db: &database::Database,
    p: PlotThreadCreatePayload,
) -> anyhow::Result<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO plot_threads (id, project_id, name, color, description, sort_order)\n         VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String(id.clone()),
            Value::String(p.project_id),
            Value::String(p.name),
            p.color.map(Value::String).unwrap_or(Value::Null),
            p.description.map(Value::String).unwrap_or(Value::Null),
            Value::String(p.sort_order),
        ],
        "run",
    )?;
    Ok(one(db.execute(
        "SELECT * FROM plot_threads WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

#[tauri::command]
pub(crate) fn plot_thread_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: PlotThreadCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_thread_create_impl(db, payload))
}

fn plot_thread_update_impl(
    db: &database::Database,
    id: String,
    patch: PlotThreadPatch,
) -> anyhow::Result<Value> {
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    if let Some(name) = patch.name {
        sets.push("name = ?");
        params.push(Value::String(name));
    }
    if let Some(color) = patch.color {
        sets.push("color = ?");
        params.push(color.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(description) = patch.description {
        sets.push("description = ?");
        params.push(description.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(sort_order) = patch.sort_order {
        sets.push("sort_order = ?");
        params.push(Value::String(sort_order));
    }
    if sets.is_empty() {
        return Ok(one(db.execute(
            "SELECT * FROM plot_threads WHERE id = ?",
            &[Value::String(id)],
            "get",
        )?));
    }
    sets.push("updated_at = datetime('now')");
    params.push(Value::String(id.clone()));
    let sql = format!("UPDATE plot_threads SET {} WHERE id = ?", sets.join(", "));
    db.execute(&sql, &params, "run")?;
    Ok(one(db.execute(
        "SELECT * FROM plot_threads WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

#[tauri::command]
pub(crate) fn plot_thread_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
    patch: PlotThreadPatch,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_thread_update_impl(db, id, patch))
}

#[tauri::command]
pub(crate) fn plot_thread_delete(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        db.execute(
            "DELETE FROM plot_threads WHERE id = ?",
            &[Value::String(id)],
            "run",
        )?;
        Ok(())
    })
}

fn plot_thread_list_impl(
    db: &database::Database,
    project_id: String,
) -> anyhow::Result<Vec<Value>> {
    let rows = db.execute(
        "SELECT * FROM plot_threads WHERE project_id = ? ORDER BY sort_order ASC",
        &[Value::String(project_id)],
        "all",
    )?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

#[tauri::command]
pub(crate) fn plot_thread_list(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| plot_thread_list_impl(db, project_id))
}

// ─────────────────────── link CRUD ───────────────────────

fn plot_thread_link_create_impl(
    db: &database::Database,
    p: PlotThreadLinkCreatePayload,
) -> anyhow::Result<Value> {
    validate_phase(&p.phase_type)?;
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO plot_thread_scene_links (id, thread_id, node_id, phase_type, note, sort_order)\n         VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String(id.clone()),
            Value::String(p.thread_id),
            Value::String(p.node_id),
            Value::String(p.phase_type),
            p.note.map(Value::String).unwrap_or(Value::Null),
            p.sort_order.map(Value::String).unwrap_or(Value::Null),
        ],
        "run",
    )?;
    Ok(one(db.execute(
        "SELECT * FROM plot_thread_scene_links WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

#[tauri::command]
pub(crate) fn plot_thread_link_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: PlotThreadLinkCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_thread_link_create_impl(db, payload))
}

fn plot_thread_link_update_impl(
    db: &database::Database,
    id: String,
    patch: PlotThreadLinkPatch,
) -> anyhow::Result<Value> {
    if let Some(ref pt) = patch.phase_type {
        validate_phase(pt)?;
    }
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    if let Some(node_id) = patch.node_id {
        sets.push("node_id = ?");
        params.push(Value::String(node_id));
    }
    if let Some(phase_type) = patch.phase_type {
        sets.push("phase_type = ?");
        params.push(Value::String(phase_type));
    }
    if let Some(note) = patch.note {
        sets.push("note = ?");
        params.push(note.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(sort_order) = patch.sort_order {
        sets.push("sort_order = ?");
        params.push(sort_order.map(Value::String).unwrap_or(Value::Null));
    }
    if sets.is_empty() {
        return Ok(one(db.execute(
            "SELECT * FROM plot_thread_scene_links WHERE id = ?",
            &[Value::String(id)],
            "get",
        )?));
    }
    sets.push("updated_at = datetime('now')");
    params.push(Value::String(id.clone()));
    let sql = format!(
        "UPDATE plot_thread_scene_links SET {} WHERE id = ?",
        sets.join(", ")
    );
    db.execute(&sql, &params, "run")?;
    Ok(one(db.execute(
        "SELECT * FROM plot_thread_scene_links WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

#[tauri::command]
pub(crate) fn plot_thread_link_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
    patch: PlotThreadLinkPatch,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_thread_link_update_impl(db, id, patch))
}

#[tauri::command]
pub(crate) fn plot_thread_link_delete(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        db.execute(
            "DELETE FROM plot_thread_scene_links WHERE id = ?",
            &[Value::String(id)],
            "run",
        )?;
        Ok(())
    })
}

fn plot_thread_list_links_impl(
    db: &database::Database,
    project_id: String,
) -> anyhow::Result<Vec<Value>> {
    let rows = db.execute(
        "SELECT l.* FROM plot_thread_scene_links l \
         JOIN plot_threads t ON t.id = l.thread_id \
         WHERE t.project_id = ?",
        &[Value::String(project_id)],
        "all",
    )?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

#[tauri::command]
pub(crate) fn plot_thread_list_links(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| plot_thread_list_links_impl(db, project_id))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.execute(
            "INSERT INTO projects (id) VALUES ('p1')",
            &[],
            "run",
        )
        .unwrap();
        db
    }

    #[test]
    fn create_then_list_roundtrips() {
        let d = db();
        let created = plot_thread_create_impl(
            &d,
            PlotThreadCreatePayload {
                project_id: "p1".into(),
                name: "復讐の糸".into(),
                color: Some("#c33".into()),
                description: None,
                sort_order: "a0".into(),
            },
        )
        .unwrap();
        assert!(created.is_object());
        let rows = plot_thread_list_impl(&d, "p1".into()).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn link_create_rejects_invalid_phase() {
        let d = db();
        plot_thread_create_impl(
            &d,
            PlotThreadCreatePayload {
                project_id: "p1".into(),
                name: "t".into(),
                color: None,
                description: None,
                sort_order: "a0".into(),
            },
        )
        .unwrap();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s1','p1','scene','S1')",
            &[],
            "run",
        )
        .unwrap();
        // thread id を取得
        let threads = plot_thread_list_impl(&d, "p1".into()).unwrap();
        let tid = threads[0]
            .as_object()
            .and_then(|o| o.get("id"))
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();

        let bad = plot_thread_link_create_impl(
            &d,
            PlotThreadLinkCreatePayload {
                thread_id: tid.clone(),
                node_id: "s1".into(),
                phase_type: "BOGUS".into(),
                note: None,
                sort_order: None,
            },
        );
        assert!(bad.is_err(), "invalid phase_type must be rejected");

        let ok = plot_thread_link_create_impl(
            &d,
            PlotThreadLinkCreatePayload {
                thread_id: tid,
                node_id: "s1".into(),
                phase_type: "introduce".into(),
                note: None,
                sort_order: None,
            },
        );
        assert!(ok.is_ok(), "valid phase_type must insert");
    }
}
